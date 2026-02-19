/**
 * Call Recording with Transcription
 *
 * Provides call recording storage and transcription
 */

export interface CallRecording {
  recordingId: string
  contactId: string
  startTime: string
  endTime: string
  duration: number
  participants: string[]
  recordingUrl: string
  transcription?: CallTranscription
  status: 'recording' | 'processing' | 'completed' | 'failed'
  createdAt: string
}

export interface CallTranscription {
  transcriptId: string
  text: string
  segments: TranscriptionSegment[]
  language: string
  confidence: number
  status: 'pending' | 'processing' | 'completed' | 'failed'
}

export interface TranscriptionSegment {
  speaker: string
  startTime: number
  endTime: number
  text: string
  confidence: number
  sentiment?: 'positive' | 'neutral' | 'negative'
}

/**
 * Call Recording Module
 */
export class CallRecording {
  /**
   * Lambda code for processing call recordings
   */
  static RecordingProcessorCode = `
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { TranscribeClient, StartTranscriptionJobCommand } = require('@aws-sdk/client-transcribe');
const { DynamoDBClient, PutItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

const s3 = new S3Client({});
const transcribe = new TranscribeClient({});
const dynamodb = new DynamoDBClient({});

const RECORDING_BUCKET = process.env.RECORDING_BUCKET;
const RECORDINGS_TABLE = process.env.RECORDINGS_TABLE;

exports.handler = async (event) => {
  console.log('Recording processor event:', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      const bucket = record.s3?.bucket?.name || RECORDING_BUCKET;
      const key = decodeURIComponent(record.s3?.object?.key?.replace(/\\+/g, ' ') || '');

      // Only process audio files
      if (!key.match(/\\.(wav|mp3|mp4|flac|ogg|webm)$/i)) continue;

      const recordingId = key.split('/').pop().replace(/\\.[^.]+$/, '');
      const now = new Date().toISOString();

      // Save recording metadata
      await dynamodb.send(new PutItemCommand({
        TableName: RECORDINGS_TABLE,
        Item: {
          recordingId: { S: recordingId },
          bucket: { S: bucket },
          key: { S: key },
          status: { S: 'processing' },
          createdAt: { S: now },
          ttl: { N: String(Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60) },
        },
      }));

      // Start transcription job
      const transcriptionJobName = \`transcribe-\${recordingId}-\${Date.now()}\`;
      const mediaUri = \`s3://\${bucket}/\${key}\`;

      await transcribe.send(new StartTranscriptionJobCommand({
        TranscriptionJobName: transcriptionJobName,
        LanguageCode: 'en-US',
        MediaFormat: key.split('.').pop().toLowerCase(),
        Media: { MediaFileUri: mediaUri },
        OutputBucketName: bucket,
        OutputKey: \`transcriptions/\${recordingId}.json\`,
        Settings: {
          ShowSpeakerLabels: true,
          MaxSpeakerLabels: 10,
          ChannelIdentification: false,
        },
      }));

      // Update status
      await dynamodb.send(new UpdateItemCommand({
        TableName: RECORDINGS_TABLE,
        Key: { recordingId: { S: recordingId } },
        UpdateExpression: 'SET transcriptionJobName = :job, #status = :status',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':job': { S: transcriptionJobName },
          ':status': { S: 'transcribing' },
        },
      }));

      console.log(\`Started transcription for: \${recordingId}\`);
    } catch (error) {
      console.error('Error processing recording:', error);
    }
  }

  return { statusCode: 200 };
};
`

  /**
   * Lambda code for transcription completion
   */
  static TranscriptionCompleteCode = `
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient, UpdateItemCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');

const s3 = new S3Client({});
const dynamodb = new DynamoDBClient({});

const RECORDING_BUCKET = process.env.RECORDING_BUCKET;
const RECORDINGS_TABLE = process.env.RECORDINGS_TABLE;

exports.handler = async (event) => {
  console.log('Transcription complete event:', JSON.stringify(event, null, 2));

  const { detail } = event;
  const jobName = detail?.TranscriptionJobName;
  const jobStatus = detail?.TranscriptionJobStatus;

  if (!jobName) return { statusCode: 400 };

  // Find recording by job name
  const queryResult = await dynamodb.send(new QueryCommand({
    TableName: RECORDINGS_TABLE,
    IndexName: 'job-index',
    KeyConditionExpression: 'transcriptionJobName = :job',
    ExpressionAttributeValues: {
      ':job': { S: jobName },
    },
  }));

  const recording = queryResult.Items?.[0];
  if (!recording) {
    console.log('Recording not found for job:', jobName);
    return { statusCode: 404 };
  }

  const recordingId = recording.recordingId.S;

  if (jobStatus === 'COMPLETED') {
    // Get transcription result
    const transcriptKey = \`transcriptions/\${recordingId}.json\`;
    const result = await s3.send(new GetObjectCommand({
      Bucket: RECORDING_BUCKET,
      Key: transcriptKey,
    }));

    const transcriptData = JSON.parse(await result.Body.transformToString());

    // Extract segments with speaker labels
    const segments = [];
    const items = transcriptData.results?.items || [];
    let currentSegment = null;

    for (const item of items) {
      if (item.type === 'pronunciation') {
        const speaker = item.speaker_label || 'spk_0';
        const startTime = parseFloat(item.start_time || 0);
        const endTime = parseFloat(item.end_time || 0);
        const content = item.alternatives?.[0]?.content || '';
        const confidence = parseFloat(item.alternatives?.[0]?.confidence || 0);

        if (!currentSegment || currentSegment.speaker !== speaker) {
          if (currentSegment) segments.push(currentSegment);
          currentSegment = {
            speaker,
            startTime,
            endTime,
            text: content,
            confidence,
          };
        } else {
          currentSegment.endTime = endTime;
          currentSegment.text += ' ' + content;
          currentSegment.confidence = (currentSegment.confidence + confidence) / 2;
        }
      }
    }
    if (currentSegment) segments.push(currentSegment);

    // Update recording with transcription
    await dynamodb.send(new UpdateItemCommand({
      TableName: RECORDINGS_TABLE,
      Key: { recordingId: { S: recordingId } },
      UpdateExpression: 'SET #status = :status, transcription = :transcript, completedAt = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': { S: 'completed' },
        ':transcript': { S: JSON.stringify({
          text: transcriptData.results?.transcripts?.[0]?.transcript || '',
          segments,
          language: 'en-US',
          confidence: segments.reduce((sum, s) => sum + s.confidence, 0) / segments.length || 0,
        })},
        ':now': { S: new Date().toISOString() },
      },
    }));

    console.log(\`Transcription completed for: \${recordingId}\`);
  } else if (jobStatus === 'FAILED') {
    await dynamodb.send(new UpdateItemCommand({
      TableName: RECORDINGS_TABLE,
      Key: { recordingId: { S: recordingId } },
      UpdateExpression: 'SET #status = :status, error = :error',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': { S: 'failed' },
        ':error': { S: detail?.FailureReason || 'Unknown error' },
      },
    }));
  }

  return { statusCode: 200 };
};
`

  /**
   * Create recordings DynamoDB table
   */
  static createRecordingsTable(config: { slug: string }): Record<string, any> {
    return {
      [`${config.slug}CallRecordingsTable`]: {
        Type: 'AWS::DynamoDB::Table',
        Properties: {
          TableName: `${config.slug}-call-recordings`,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: 'recordingId', AttributeType: 'S' },
            { AttributeName: 'transcriptionJobName', AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: 'recordingId', KeyType: 'HASH' },
          ],
          GlobalSecondaryIndexes: [
            {
              IndexName: 'job-index',
              KeySchema: [
                { AttributeName: 'transcriptionJobName', KeyType: 'HASH' },
              ],
              Projection: { ProjectionType: 'ALL' },
            },
          ],
          TimeToLiveSpecification: {
            AttributeName: 'ttl',
            Enabled: true,
          },
        },
      },
    }
  }

  /**
   * Create recording processor Lambda
   */
  static createRecordingProcessorLambda(config: {
    slug: string
    roleArn: string
    recordingBucket: string
    recordingsTable: string
  }): Record<string, any> {
    return {
      [`${config.slug}RecordingProcessorLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-recording-processor`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 60,
          MemorySize: 256,
          Code: {
            ZipFile: CallRecording.RecordingProcessorCode,
          },
          Environment: {
            Variables: {
              RECORDING_BUCKET: config.recordingBucket,
              RECORDINGS_TABLE: config.recordingsTable,
            },
          },
        },
      },
    }
  }
}

export default CallRecording
