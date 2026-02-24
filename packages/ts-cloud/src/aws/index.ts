/**
 * AWS Integration Layer
 * Direct API calls for AWS services (no SDK dependencies)
 */

export * from './client'
export * from './cloudformation'
export * from './ec2'
export * from './s3'
export * from './cloudfront'
export * from './route53'
export * from './route53-domains'
export * from './acm'
export * from './ecr'
export * from './ecs'
export * from './sts'
export * from './ssm'
export * from './secrets-manager'
export * from './ses'
export * from './email'
export * from './sns'
export * from './sqs'
export * from './lambda'
export * from './cloudwatch-logs'
export * from './connect'
export * from './elbv2'
export * from './rds'
export * from './dynamodb'
export * from './opensearch'
export * from './transcribe'
export * from './bedrock'
export * from './comprehend'

// Rekognition - export class and functions
export {
  RekognitionClient,
  detectLabelsFromS3,
  countFacesInS3Image,
  isContentSafe,
} from './rekognition'

// Rekognition - export types with prefixed names to avoid conflicts
export type {
  S3Object as RekognitionS3Object,
  BoundingBox as RekognitionBoundingBox,
  Image,
  Video,
  Landmark,
  Pose,
  ImageQuality,
  Emotion,
  FaceDetail,
  DetectFacesCommandInput,
  DetectFacesCommandOutput,
  Label,
  DetectLabelsCommandInput,
  DetectLabelsCommandOutput,
  DetectTextCommandInput,
  TextDetection,
  DetectTextCommandOutput,
  DetectModerationLabelsCommandInput,
  ModerationLabel,
  DetectModerationLabelsCommandOutput,
  Celebrity,
  RecognizeCelebritiesCommandInput,
  RecognizeCelebritiesCommandOutput,
  CompareFacesCommandInput,
  CompareFacesMatch,
  CompareFacesCommandOutput,
  CreateCollectionCommandInput,
  CreateCollectionCommandOutput,
  DeleteCollectionCommandInput,
  DeleteCollectionCommandOutput,
  ListCollectionsCommandInput,
  ListCollectionsCommandOutput,
  IndexFacesCommandInput,
  FaceRecord,
  IndexFacesCommandOutput,
  SearchFacesByImageCommandInput,
  FaceMatch,
  SearchFacesByImageCommandOutput,
  SearchFacesCommandInput,
  SearchFacesCommandOutput,
  StartLabelDetectionCommandInput,
  StartLabelDetectionCommandOutput,
  GetLabelDetectionCommandInput,
  LabelDetection,
  GetLabelDetectionCommandOutput,
  StartFaceDetectionCommandInput,
  StartFaceDetectionCommandOutput,
  GetFaceDetectionCommandInput,
  FaceDetection,
  GetFaceDetectionCommandOutput,
  StartContentModerationCommandInput,
  StartContentModerationCommandOutput,
  GetContentModerationCommandInput,
  ContentModerationDetection,
  GetContentModerationCommandOutput,
} from './rekognition'

// Textract - export class and functions
export {
  TextractClient,
  extractTextFromS3,
  extractFormsFromS3,
  extractTablesFromS3,
} from './textract'

// Textract - export types with prefixed names to avoid conflicts
export type {
  S3Object as TextractS3Object,
  BoundingBox as TextractBoundingBox,
  Document,
  Point,
  Geometry,
  Relationship,
  Block,
  DocumentMetadata,
  Warning,
  DetectDocumentTextCommandInput,
  DetectDocumentTextCommandOutput,
  AnalyzeDocumentCommandInput,
  AnalyzeDocumentCommandOutput,
  AnalyzeExpenseCommandInput,
  ExpenseField,
  LineItemGroup,
  ExpenseDocument,
  AnalyzeExpenseCommandOutput,
  AnalyzeIDCommandInput,
  IdentityDocument,
  AnalyzeIDCommandOutput,
  StartDocumentTextDetectionCommandInput,
  StartDocumentTextDetectionCommandOutput,
  GetDocumentTextDetectionCommandInput,
  GetDocumentTextDetectionCommandOutput,
  StartDocumentAnalysisCommandInput,
  StartDocumentAnalysisCommandOutput,
  GetDocumentAnalysisCommandInput,
  GetDocumentAnalysisCommandOutput,
  StartExpenseAnalysisCommandInput,
  StartExpenseAnalysisCommandOutput,
  GetExpenseAnalysisCommandInput,
  GetExpenseAnalysisCommandOutput,
  StartLendingAnalysisCommandInput,
  StartLendingAnalysisCommandOutput,
  GetLendingAnalysisCommandInput,
  LendingDocument,
  LendingResult,
  GetLendingAnalysisCommandOutput,
} from './textract'

export * from './polly'
export * from './translate'
export * from './personalize'

// Kendra - export class and functions
export {
  KendraClient,
  search,
  retrieveForRag,
} from './kendra'

// Kendra - export types with prefixed names to avoid conflicts with Bedrock
export type {
  CreateIndexCommandInput as KendraCreateIndexCommandInput,
  CreateIndexCommandOutput as KendraCreateIndexCommandOutput,
  DescribeIndexCommandInput,
  Index,
  DescribeIndexCommandOutput,
  ListIndicesCommandInput,
  IndexSummary,
  ListIndicesCommandOutput,
  DeleteIndexCommandInput,
  DeleteIndexCommandOutput,
  CreateDataSourceCommandInput as KendraCreateDataSourceCommandInput,
  CreateDataSourceCommandOutput as KendraCreateDataSourceCommandOutput,
  DescribeDataSourceCommandInput,
  DataSource,
  DescribeDataSourceCommandOutput,
  ListDataSourcesCommandInput as KendraListDataSourcesCommandInput,
  DataSourceSummary,
  ListDataSourcesCommandOutput as KendraListDataSourcesCommandOutput,
  StartDataSourceSyncJobCommandInput,
  StartDataSourceSyncJobCommandOutput,
  StopDataSourceSyncJobCommandInput,
  StopDataSourceSyncJobCommandOutput,
  QueryCommandInput,
  QueryResultItem,
  FacetResult,
  QueryCommandOutput,
  RetrieveCommandInput,
  RetrieveResultItem,
  RetrieveCommandOutput,
  BatchPutDocumentCommandInput,
  BatchPutDocumentCommandOutput,
  BatchDeleteDocumentCommandInput,
  BatchDeleteDocumentCommandOutput,
} from './kendra'

export * from './eventbridge'
export * from './elasticache'
export * from './scheduler'
export * from './iam'
export * from './application-autoscaling'
export * from './imap-server'
export * from './smtp-server'
export * from './sms'
export * from './voice'
export * from './support'
export * from './setup-sms'
export * from './efs'

// DNS Provider integrations (Route53, Porkbun, GoDaddy)
export * from '../dns'
