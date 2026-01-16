/**
 * Email Search and Indexing
 *
 * Provides OpenSearch integration for email search functionality
 */

export interface EmailSearchConfig {
  slug: string
  environment: string
  domainName?: string
  instanceType?: string
  instanceCount?: number
  ebsVolumeSize?: number
  masterUserName?: string
  masterUserPassword?: string
}

export interface EmailSearchDocument {
  messageId: string
  from: string
  fromName?: string
  to: string
  toName?: string
  cc?: string[]
  subject: string
  body: string
  bodyPreview: string
  date: string
  receivedAt: string
  hasAttachments: boolean
  attachmentNames?: string[]
  labels?: string[]
  folder: string
  threadId?: string
  isRead: boolean
  isStarred?: boolean
  mailbox: string
}

export interface SearchQuery {
  query: string
  from?: string
  to?: string
  subject?: string
  hasAttachments?: boolean
  dateFrom?: string
  dateTo?: string
  folder?: string
  labels?: string[]
  isRead?: boolean
  limit?: number
  offset?: number
  sort?: 'date' | 'relevance'
  sortOrder?: 'asc' | 'desc'
}

export interface SearchResult {
  total: number
  hits: Array<{
    score: number
    document: EmailSearchDocument
    highlights?: Record<string, string[]>
  }>
}

/**
 * Email Search Module
 */
export class EmailSearch {
  /**
   * Create OpenSearch domain for email indexing
   */
  static createSearchDomain(config: EmailSearchConfig): Record<string, any> {
    const {
      slug,
      environment,
      domainName,
      instanceType = 't3.small.search',
      instanceCount = 1,
      ebsVolumeSize = 10,
      masterUserName = 'admin',
      masterUserPassword,
    } = config

    const domain = domainName || `${slug}-${environment}-email-search`

    return {
      [`${slug}EmailSearchDomain`]: {
        Type: 'AWS::OpenSearchService::Domain',
        Properties: {
          DomainName: domain,
          EngineVersion: 'OpenSearch_2.11',
          ClusterConfig: {
            InstanceType: instanceType,
            InstanceCount: instanceCount,
            DedicatedMasterEnabled: false,
            ZoneAwarenessEnabled: false,
          },
          EBSOptions: {
            EBSEnabled: true,
            VolumeType: 'gp3',
            VolumeSize: ebsVolumeSize,
          },
          NodeToNodeEncryptionOptions: {
            Enabled: true,
          },
          EncryptionAtRestOptions: {
            Enabled: true,
          },
          DomainEndpointOptions: {
            EnforceHTTPS: true,
          },
          AdvancedSecurityOptions: {
            Enabled: true,
            InternalUserDatabaseEnabled: true,
            MasterUserOptions: {
              MasterUserName: masterUserName,
              MasterUserPassword: masterUserPassword || `${slug}-search-${Date.now()}`,
            },
          },
          AccessPolicies: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: { AWS: '*' },
                Action: 'es:*',
                Resource: `arn:aws:es:*:*:domain/${domain}/*`,
              },
            ],
          },
        },
      },
    }
  }

  /**
   * Create Lambda for indexing emails
   */
  static createIndexerLambda(config: {
    slug: string
    roleArn: string
    searchDomainEndpoint: string
    emailBucket: string
  }): Record<string, any> {
    return {
      [`${config.slug}EmailIndexerLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-email-indexer`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 60,
          MemorySize: 512,
          Code: {
            ZipFile: EmailSearch.IndexerLambdaCode,
          },
          Environment: {
            Variables: {
              OPENSEARCH_ENDPOINT: config.searchDomainEndpoint,
              EMAIL_BUCKET: config.emailBucket,
            },
          },
        },
      },
    }
  }

  /**
   * Lambda code for email indexing
   */
  static IndexerLambdaCode = `
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const https = require('https');

const s3 = new S3Client({});
const OPENSEARCH_ENDPOINT = process.env.OPENSEARCH_ENDPOINT;

exports.handler = async (event) => {
  console.log('Email indexer event:', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      const bucket = record.s3.bucket.name;
      const key = decodeURIComponent(record.s3.object.key.replace(/\\+/g, ' '));

      // Only index metadata.json files
      if (!key.endsWith('/metadata.json')) continue;

      // Get metadata
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const metadata = JSON.parse(await result.Body.transformToString());

      // Get body preview
      let bodyPreview = '';
      try {
        const previewKey = key.replace('/metadata.json', '/preview.txt');
        const previewResult = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: previewKey }));
        bodyPreview = await previewResult.Body.transformToString();
      } catch {}

      // Get full body for indexing
      let body = '';
      try {
        const textKey = key.replace('/metadata.json', '/body.txt');
        const textResult = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: textKey }));
        body = await textResult.Body.transformToString();
      } catch {}

      // Extract mailbox from path
      const pathParts = key.split('/');
      const mailbox = pathParts[1] + '@' + pathParts[2];

      // Build search document
      const doc = {
        messageId: metadata.messageId,
        from: metadata.from,
        fromName: metadata.fromName,
        to: metadata.to,
        toName: metadata.toName,
        subject: metadata.subject,
        body: body.substring(0, 50000), // Limit body size
        bodyPreview,
        date: metadata.date,
        receivedAt: metadata.receivedAt,
        hasAttachments: metadata.hasAttachments || false,
        attachmentNames: metadata.attachments?.map(a => a.filename) || [],
        folder: 'inbox',
        mailbox,
        isRead: false,
      };

      // Index to OpenSearch
      await indexDocument(doc);

      console.log('Indexed email:', metadata.messageId);
    } catch (error) {
      console.error('Error indexing email:', error);
    }
  }

  return { statusCode: 200 };
};

async function indexDocument(doc) {
  return new Promise((resolve, reject) => {
    const url = new URL(OPENSEARCH_ENDPOINT);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: '/emails/_doc/' + doc.messageId,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });

    req.on('error', reject);
    req.write(JSON.stringify(doc));
    req.end();
  });
}
`

  /**
   * Create email index mapping
   */
  static getIndexMapping(): Record<string, any> {
    return {
      mappings: {
        properties: {
          messageId: { type: 'keyword' },
          from: { type: 'keyword' },
          fromName: { type: 'text' },
          to: { type: 'keyword' },
          toName: { type: 'text' },
          cc: { type: 'keyword' },
          subject: {
            type: 'text',
            analyzer: 'standard',
            fields: {
              keyword: { type: 'keyword' },
            },
          },
          body: {
            type: 'text',
            analyzer: 'standard',
          },
          bodyPreview: { type: 'text' },
          date: { type: 'date' },
          receivedAt: { type: 'date' },
          hasAttachments: { type: 'boolean' },
          attachmentNames: { type: 'keyword' },
          labels: { type: 'keyword' },
          folder: { type: 'keyword' },
          threadId: { type: 'keyword' },
          isRead: { type: 'boolean' },
          isStarred: { type: 'boolean' },
          mailbox: { type: 'keyword' },
        },
      },
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
      },
    }
  }

  /**
   * Build OpenSearch query from search parameters
   */
  static buildSearchQuery(params: SearchQuery): Record<string, any> {
    const must: any[] = []
    const filter: any[] = []

    // Full-text search
    if (params.query) {
      must.push({
        multi_match: {
          query: params.query,
          fields: ['subject^3', 'body', 'fromName', 'toName'],
          type: 'best_fields',
          fuzziness: 'AUTO',
        },
      })
    }

    // Filters
    if (params.from) {
      filter.push({ term: { from: params.from } })
    }

    if (params.to) {
      filter.push({ term: { to: params.to } })
    }

    if (params.subject) {
      must.push({ match_phrase: { subject: params.subject } })
    }

    if (params.hasAttachments !== undefined) {
      filter.push({ term: { hasAttachments: params.hasAttachments } })
    }

    if (params.folder) {
      filter.push({ term: { folder: params.folder } })
    }

    if (params.labels && params.labels.length > 0) {
      filter.push({ terms: { labels: params.labels } })
    }

    if (params.isRead !== undefined) {
      filter.push({ term: { isRead: params.isRead } })
    }

    // Date range
    if (params.dateFrom || params.dateTo) {
      const range: any = { date: {} }
      if (params.dateFrom) range.date.gte = params.dateFrom
      if (params.dateTo) range.date.lte = params.dateTo
      filter.push({ range })
    }

    // Build query
    const query: any = {
      bool: {},
    }

    if (must.length > 0) {
      query.bool.must = must
    }

    if (filter.length > 0) {
      query.bool.filter = filter
    }

    // If no conditions, match all
    if (must.length === 0 && filter.length === 0) {
      query.bool.must = [{ match_all: {} }]
    }

    // Sort
    const sort: any[] = []
    if (params.sort === 'relevance' && params.query) {
      sort.push({ _score: params.sortOrder || 'desc' })
    }
    sort.push({ date: params.sortOrder || 'desc' })

    return {
      query,
      sort,
      from: params.offset || 0,
      size: params.limit || 20,
      highlight: {
        fields: {
          subject: {},
          body: { fragment_size: 150, number_of_fragments: 3 },
        },
      },
    }
  }
}

export default EmailSearch
