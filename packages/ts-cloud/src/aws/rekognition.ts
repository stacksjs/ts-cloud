/**
 * AWS Rekognition Client
 * Image and video analysis - face detection, object detection, celebrity recognition
 * No external SDK dependencies - implements AWS Signature V4 directly
*/

import { AWSClient } from './client'

// ============================================================================
// Types
// ============================================================================

export interface S3Object {
  Bucket?: string
  Name?: string
  Version?: string
}

export interface Image {
  Bytes?: Uint8Array
  S3Object?: S3Object
}

export interface Video {
  S3Object?: S3Object
}

export interface BoundingBox {
  Width?: number
  Height?: number
  Left?: number
  Top?: number
}

export interface Landmark {
  Type?: string
  X?: number
  Y?: number
}

export interface Pose {
  Roll?: number
  Yaw?: number
  Pitch?: number
}

export interface ImageQuality {
  Brightness?: number
  Sharpness?: number
}

export interface Emotion {
  Type?: 'HAPPY' | 'SAD' | 'ANGRY' | 'CONFUSED' | 'DISGUSTED' | 'SURPRISED' | 'CALM' | 'UNKNOWN' | 'FEAR'
  Confidence?: number
}

export interface FaceDetail {
  BoundingBox?: BoundingBox
  AgeRange?: { Low?: number; High?: number }
  Smile?: { Value?: boolean; Confidence?: number }
  Eyeglasses?: { Value?: boolean; Confidence?: number }
  Sunglasses?: { Value?: boolean; Confidence?: number }
  Gender?: { Value?: 'Male' | 'Female'; Confidence?: number }
  Beard?: { Value?: boolean; Confidence?: number }
  Mustache?: { Value?: boolean; Confidence?: number }
  EyesOpen?: { Value?: boolean; Confidence?: number }
  MouthOpen?: { Value?: boolean; Confidence?: number }
  Emotions?: Emotion[]
  Landmarks?: Landmark[]
  Pose?: Pose
  Quality?: ImageQuality
  Confidence?: number
  FaceOccluded?: { Value?: boolean; Confidence?: number }
  EyeDirection?: { Yaw?: number; Pitch?: number; Confidence?: number }
}

export interface DetectFacesCommandInput {
  Image: Image
  Attributes?: ('DEFAULT' | 'ALL' | 'AGE_RANGE' | 'BEARD' | 'EMOTIONS' | 'EYE_DIRECTION' | 'EYEGLASSES' | 'EYES_OPEN' | 'FACE_OCCLUDED' | 'GENDER' | 'MOUTH_OPEN' | 'MUSTACHE' | 'POSE' | 'QUALITY' | 'SMILE' | 'SUNGLASSES')[]
}

export interface DetectFacesCommandOutput {
  FaceDetails?: FaceDetail[]
  OrientationCorrection?: 'ROTATE_0' | 'ROTATE_90' | 'ROTATE_180' | 'ROTATE_270'
}

export interface Label {
  Name?: string
  Confidence?: number
  Instances?: Array<{
    BoundingBox?: BoundingBox
    Confidence?: number
    DominantColors?: Array<{
      Red?: number
      Green?: number
      Blue?: number
      HexCode?: string
      SimplifiedColor?: string
      CSSColor?: string
      PixelPercent?: number
    }>
  }>
  Parents?: Array<{ Name?: string }>
  Aliases?: Array<{ Name?: string }>
  Categories?: Array<{ Name?: string }>
}

export interface DetectLabelsCommandInput {
  Image: Image
  MaxLabels?: number
  MinConfidence?: number
  Features?: ('GENERAL_LABELS' | 'IMAGE_PROPERTIES')[]
  Settings?: {
    GeneralLabels?: {
      LabelInclusionFilters?: string[]
      LabelExclusionFilters?: string[]
      LabelCategoryInclusionFilters?: string[]
      LabelCategoryExclusionFilters?: string[]
    }
    ImageProperties?: {
      MaxDominantColors?: number
    }
  }
}

export interface DetectLabelsCommandOutput {
  Labels?: Label[]
  OrientationCorrection?: string
  LabelModelVersion?: string
  ImageProperties?: {
    Quality?: {
      Brightness?: number
      Sharpness?: number
      Contrast?: number
    }
    DominantColors?: Array<{
      Red?: number
      Green?: number
      Blue?: number
      HexCode?: string
      SimplifiedColor?: string
      CSSColor?: string
      PixelPercent?: number
    }>
    Foreground?: {
      Quality?: { Brightness?: number; Sharpness?: number }
      DominantColors?: Array<{
        Red?: number
        Green?: number
        Blue?: number
        HexCode?: string
        CSSColor?: string
        PixelPercent?: number
      }>
    }
    Background?: {
      Quality?: { Brightness?: number; Sharpness?: number }
      DominantColors?: Array<{
        Red?: number
        Green?: number
        Blue?: number
        HexCode?: string
        CSSColor?: string
        PixelPercent?: number
      }>
    }
  }
}

export interface DetectTextCommandInput {
  Image: Image
  Filters?: {
    WordFilter?: {
      MinConfidence?: number
      MinBoundingBoxHeight?: number
      MinBoundingBoxWidth?: number
    }
    RegionsOfInterest?: Array<{
      BoundingBox?: BoundingBox
      Polygon?: Array<{ X?: number; Y?: number }>
    }>
  }
}

export interface TextDetection {
  DetectedText?: string
  Type?: 'LINE' | 'WORD'
  Id?: number
  ParentId?: number
  Confidence?: number
  Geometry?: {
    BoundingBox?: BoundingBox
    Polygon?: Array<{ X?: number; Y?: number }>
  }
}

export interface DetectTextCommandOutput {
  TextDetections?: TextDetection[]
  TextModelVersion?: string
}

export interface DetectModerationLabelsCommandInput {
  Image: Image
  MinConfidence?: number
  HumanLoopConfig?: {
    HumanLoopName: string
    FlowDefinitionArn: string
    DataAttributes?: {
      ContentClassifiers?: ('FreeOfPersonallyIdentifiableInformation' | 'FreeOfAdultContent')[]
    }
  }
  ProjectVersion?: string
}

export interface ModerationLabel {
  Confidence?: number
  Name?: string
  ParentName?: string
  TaxonomyLevel?: number
}

export interface DetectModerationLabelsCommandOutput {
  ModerationLabels?: ModerationLabel[]
  ModerationModelVersion?: string
  HumanLoopActivationOutput?: {
    HumanLoopArn?: string
    HumanLoopActivationReasons?: string[]
    HumanLoopActivationConditionsEvaluationResults?: string
  }
  ProjectVersion?: string
  ContentTypes?: Array<{
    Confidence?: number
    Name?: string
  }>
}

export interface Celebrity {
  Urls?: string[]
  Name?: string
  Id?: string
  Face?: {
    BoundingBox?: BoundingBox
    Confidence?: number
    Landmarks?: Landmark[]
    Pose?: Pose
    Quality?: ImageQuality
    Emotions?: Emotion[]
    Smile?: { Value?: boolean; Confidence?: number }
  }
  MatchConfidence?: number
  KnownGender?: { Type?: 'Male' | 'Female' | 'Nonbinary' | 'Unlisted' }
}

export interface RecognizeCelebritiesCommandInput {
  Image: Image
}

export interface RecognizeCelebritiesCommandOutput {
  CelebrityFaces?: Celebrity[]
  UnrecognizedFaces?: FaceDetail[]
  OrientationCorrection?: string
}

export interface CompareFacesCommandInput {
  SourceImage: Image
  TargetImage: Image
  SimilarityThreshold?: number
  QualityFilter?: 'NONE' | 'AUTO' | 'LOW' | 'MEDIUM' | 'HIGH'
}

export interface CompareFacesMatch {
  Similarity?: number
  Face?: {
    BoundingBox?: BoundingBox
    Confidence?: number
    Landmarks?: Landmark[]
    Pose?: Pose
    Quality?: ImageQuality
    Emotions?: Emotion[]
    Smile?: { Value?: boolean; Confidence?: number }
  }
}

export interface CompareFacesCommandOutput {
  SourceImageFace?: {
    BoundingBox?: BoundingBox
    Confidence?: number
  }
  FaceMatches?: CompareFacesMatch[]
  UnmatchedFaces?: FaceDetail[]
  SourceImageOrientationCorrection?: string
  TargetImageOrientationCorrection?: string
}

export interface CreateCollectionCommandInput {
  CollectionId: string
  Tags?: Record<string, string>
}

export interface CreateCollectionCommandOutput {
  StatusCode?: number
  CollectionArn?: string
  FaceModelVersion?: string
}

export interface DeleteCollectionCommandInput {
  CollectionId: string
}

export interface DeleteCollectionCommandOutput {
  StatusCode?: number
}

export interface ListCollectionsCommandInput {
  NextToken?: string
  MaxResults?: number
}

export interface ListCollectionsCommandOutput {
  CollectionIds?: string[]
  NextToken?: string
  FaceModelVersions?: string[]
}

export interface IndexFacesCommandInput {
  CollectionId: string
  Image: Image
  ExternalImageId?: string
  DetectionAttributes?: ('DEFAULT' | 'ALL')[]
  MaxFaces?: number
  QualityFilter?: 'NONE' | 'AUTO' | 'LOW' | 'MEDIUM' | 'HIGH'
}

export interface FaceRecord {
  Face?: {
    FaceId?: string
    BoundingBox?: BoundingBox
    ImageId?: string
    ExternalImageId?: string
    Confidence?: number
    IndexFacesModelVersion?: string
  }
  FaceDetail?: FaceDetail
}

export interface IndexFacesCommandOutput {
  FaceRecords?: FaceRecord[]
  OrientationCorrection?: string
  FaceModelVersion?: string
  UnindexedFaces?: Array<{
    Reasons?: ('EXCEEDS_MAX_FACES' | 'EXTREME_POSE' | 'LOW_BRIGHTNESS' | 'LOW_SHARPNESS' | 'LOW_CONFIDENCE' | 'SMALL_BOUNDING_BOX' | 'LOW_FACE_QUALITY')[]
    FaceDetail?: FaceDetail
  }>
}

export interface SearchFacesByImageCommandInput {
  CollectionId: string
  Image: Image
  MaxFaces?: number
  FaceMatchThreshold?: number
  QualityFilter?: 'NONE' | 'AUTO' | 'LOW' | 'MEDIUM' | 'HIGH'
}

export interface FaceMatch {
  Similarity?: number
  Face?: {
    FaceId?: string
    BoundingBox?: BoundingBox
    ImageId?: string
    ExternalImageId?: string
    Confidence?: number
    IndexFacesModelVersion?: string
  }
}

export interface SearchFacesByImageCommandOutput {
  SearchedFaceBoundingBox?: BoundingBox
  SearchedFaceConfidence?: number
  FaceMatches?: FaceMatch[]
  FaceModelVersion?: string
}

export interface SearchFacesCommandInput {
  CollectionId: string
  FaceId: string
  MaxFaces?: number
  FaceMatchThreshold?: number
}

export interface SearchFacesCommandOutput {
  SearchedFaceId?: string
  FaceMatches?: FaceMatch[]
  FaceModelVersion?: string
}

export interface StartLabelDetectionCommandInput {
  Video: Video
  ClientRequestToken?: string
  MinConfidence?: number
  NotificationChannel?: {
    SNSTopicArn: string
    RoleArn: string
  }
  JobTag?: string
  Features?: ('GENERAL_LABELS' | 'IMAGE_PROPERTIES')[]
  Settings?: {
    GeneralLabels?: {
      LabelInclusionFilters?: string[]
      LabelExclusionFilters?: string[]
      LabelCategoryInclusionFilters?: string[]
      LabelCategoryExclusionFilters?: string[]
    }
  }
}

export interface StartLabelDetectionCommandOutput {
  JobId?: string
}

export interface GetLabelDetectionCommandInput {
  JobId: string
  MaxResults?: number
  NextToken?: string
  SortBy?: 'NAME' | 'TIMESTAMP'
  AggregateBy?: 'TIMESTAMPS' | 'SEGMENTS'
}

export interface LabelDetection {
  Timestamp?: number
  Label?: Label
  StartTimestampMillis?: number
  EndTimestampMillis?: number
  DurationMillis?: number
}

export interface GetLabelDetectionCommandOutput {
  JobStatus?: 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED'
  StatusMessage?: string
  VideoMetadata?: {
    Codec?: string
    DurationMillis?: number
    Format?: string
    FrameRate?: number
    FrameHeight?: number
    FrameWidth?: number
    ColorRange?: string
  }
  NextToken?: string
  Labels?: LabelDetection[]
  LabelModelVersion?: string
  JobId?: string
  Video?: { S3Object?: S3Object }
  JobTag?: string
  GetRequestMetadata?: {
    SortBy?: string
    AggregateBy?: string
  }
}

export interface StartFaceDetectionCommandInput {
  Video: Video
  ClientRequestToken?: string
  NotificationChannel?: {
    SNSTopicArn: string
    RoleArn: string
  }
  FaceAttributes?: 'DEFAULT' | 'ALL'
  JobTag?: string
}

export interface StartFaceDetectionCommandOutput {
  JobId?: string
}

export interface GetFaceDetectionCommandInput {
  JobId: string
  MaxResults?: number
  NextToken?: string
}

export interface FaceDetection {
  Timestamp?: number
  Face?: FaceDetail
}

export interface GetFaceDetectionCommandOutput {
  JobStatus?: 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED'
  StatusMessage?: string
  VideoMetadata?: {
    Codec?: string
    DurationMillis?: number
    Format?: string
    FrameRate?: number
    FrameHeight?: number
    FrameWidth?: number
  }
  NextToken?: string
  Faces?: FaceDetection[]
  JobId?: string
  Video?: { S3Object?: S3Object }
  JobTag?: string
}

export interface StartContentModerationCommandInput {
  Video: Video
  MinConfidence?: number
  ClientRequestToken?: string
  NotificationChannel?: {
    SNSTopicArn: string
    RoleArn: string
  }
  JobTag?: string
}

export interface StartContentModerationCommandOutput {
  JobId?: string
}

export interface GetContentModerationCommandInput {
  JobId: string
  MaxResults?: number
  NextToken?: string
  SortBy?: 'NAME' | 'TIMESTAMP'
  AggregateBy?: 'TIMESTAMPS' | 'SEGMENTS'
}

export interface ContentModerationDetection {
  Timestamp?: number
  ModerationLabel?: ModerationLabel
  StartTimestampMillis?: number
  EndTimestampMillis?: number
  DurationMillis?: number
  ContentTypes?: Array<{
    Confidence?: number
    Name?: string
  }>
}

export interface GetContentModerationCommandOutput {
  JobStatus?: 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED'
  StatusMessage?: string
  VideoMetadata?: {
    Codec?: string
    DurationMillis?: number
    Format?: string
    FrameRate?: number
    FrameHeight?: number
    FrameWidth?: number
  }
  ModerationLabels?: ContentModerationDetection[]
  NextToken?: string
  ModerationModelVersion?: string
  JobId?: string
  Video?: { S3Object?: S3Object }
  JobTag?: string
  GetRequestMetadata?: {
    SortBy?: string
    AggregateBy?: string
  }
}

// ============================================================================
// Rekognition Client
// ============================================================================

export class RekognitionClient {
  private client: AWSClient
  private region: string

  constructor(region: string = 'us-east-1') {
    this.region = region
    this.client = new AWSClient()
  }

  private async request<T>(action: string, params: Record<string, unknown>): Promise<T> {
    return this.client.request({
      service: 'rekognition',
      region: this.region,
      method: 'POST',
      path: '/',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `RekognitionService.${action}`,
      },
      body: JSON.stringify(params),
    })
  }

  // -------------------------------------------------------------------------
  // Image Analysis
  // -------------------------------------------------------------------------

  /**
   * Detect faces in an image
  */
  async detectFaces(params: DetectFacesCommandInput): Promise<DetectFacesCommandOutput> {
    return this.request('DetectFaces', params as unknown as Record<string, unknown>)
  }

  /**
   * Detect labels (objects, scenes, concepts) in an image
  */
  async detectLabels(params: DetectLabelsCommandInput): Promise<DetectLabelsCommandOutput> {
    return this.request('DetectLabels', params as unknown as Record<string, unknown>)
  }

  /**
   * Detect text in an image
  */
  async detectText(params: DetectTextCommandInput): Promise<DetectTextCommandOutput> {
    return this.request('DetectText', params as unknown as Record<string, unknown>)
  }

  /**
   * Detect moderation labels (unsafe content)
  */
  async detectModerationLabels(params: DetectModerationLabelsCommandInput): Promise<DetectModerationLabelsCommandOutput> {
    return this.request('DetectModerationLabels', params as unknown as Record<string, unknown>)
  }

  /**
   * Recognize celebrities in an image
  */
  async recognizeCelebrities(params: RecognizeCelebritiesCommandInput): Promise<RecognizeCelebritiesCommandOutput> {
    return this.request('RecognizeCelebrities', params as unknown as Record<string, unknown>)
  }

  /**
   * Compare faces between source and target images
  */
  async compareFaces(params: CompareFacesCommandInput): Promise<CompareFacesCommandOutput> {
    return this.request('CompareFaces', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Face Collection Management
  // -------------------------------------------------------------------------

  /**
   * Create a face collection
  */
  async createCollection(params: CreateCollectionCommandInput): Promise<CreateCollectionCommandOutput> {
    return this.request('CreateCollection', params as unknown as Record<string, unknown>)
  }

  /**
   * Delete a face collection
  */
  async deleteCollection(params: DeleteCollectionCommandInput): Promise<DeleteCollectionCommandOutput> {
    return this.request('DeleteCollection', params as unknown as Record<string, unknown>)
  }

  /**
   * List face collections
  */
  async listCollections(params?: ListCollectionsCommandInput): Promise<ListCollectionsCommandOutput> {
    return this.request('ListCollections', (params || {}) as unknown as Record<string, unknown>)
  }

  /**
   * Index faces from an image into a collection
  */
  async indexFaces(params: IndexFacesCommandInput): Promise<IndexFacesCommandOutput> {
    return this.request('IndexFaces', params as unknown as Record<string, unknown>)
  }

  /**
   * Search for faces in a collection using an image
  */
  async searchFacesByImage(params: SearchFacesByImageCommandInput): Promise<SearchFacesByImageCommandOutput> {
    return this.request('SearchFacesByImage', params as unknown as Record<string, unknown>)
  }

  /**
   * Search for faces in a collection using a face ID
  */
  async searchFaces(params: SearchFacesCommandInput): Promise<SearchFacesCommandOutput> {
    return this.request('SearchFaces', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Video Analysis
  // -------------------------------------------------------------------------

  /**
   * Start async label detection on video
  */
  async startLabelDetection(params: StartLabelDetectionCommandInput): Promise<StartLabelDetectionCommandOutput> {
    return this.request('StartLabelDetection', params as unknown as Record<string, unknown>)
  }

  /**
   * Get results of label detection job
  */
  async getLabelDetection(params: GetLabelDetectionCommandInput): Promise<GetLabelDetectionCommandOutput> {
    return this.request('GetLabelDetection', params as unknown as Record<string, unknown>)
  }

  /**
   * Start async face detection on video
  */
  async startFaceDetection(params: StartFaceDetectionCommandInput): Promise<StartFaceDetectionCommandOutput> {
    return this.request('StartFaceDetection', params as unknown as Record<string, unknown>)
  }

  /**
   * Get results of face detection job
  */
  async getFaceDetection(params: GetFaceDetectionCommandInput): Promise<GetFaceDetectionCommandOutput> {
    return this.request('GetFaceDetection', params as unknown as Record<string, unknown>)
  }

  /**
   * Start async content moderation on video
  */
  async startContentModeration(params: StartContentModerationCommandInput): Promise<StartContentModerationCommandOutput> {
    return this.request('StartContentModeration', params as unknown as Record<string, unknown>)
  }

  /**
   * Get results of content moderation job
  */
  async getContentModeration(params: GetContentModerationCommandInput): Promise<GetContentModerationCommandOutput> {
    return this.request('GetContentModeration', params as unknown as Record<string, unknown>)
  }

  // -------------------------------------------------------------------------
  // Convenience Methods
  // -------------------------------------------------------------------------

  /**
   * Analyze an image from S3 and get all labels
  */
  async analyzeS3Image(bucket: string, key: string, options?: { maxLabels?: number; minConfidence?: number }): Promise<Label[]> {
    const result = await this.detectLabels({
      Image: { S3Object: { Bucket: bucket, Name: key } },
      MaxLabels: options?.maxLabels,
      MinConfidence: options?.minConfidence,
    })
    return result.Labels || []
  }

  /**
   * Analyze image bytes and get all labels
  */
  async analyzeImageBytes(bytes: Uint8Array, options?: { maxLabels?: number; minConfidence?: number }): Promise<Label[]> {
    const result = await this.detectLabels({
      Image: { Bytes: bytes },
      MaxLabels: options?.maxLabels,
      MinConfidence: options?.minConfidence,
    })
    return result.Labels || []
  }

  /**
   * Check if image is safe (no moderation labels above threshold)
  */
  async isImageSafe(image: Image, threshold: number = 50): Promise<boolean> {
    const result = await this.detectModerationLabels({
      Image: image,
      MinConfidence: threshold,
    })
    return (result.ModerationLabels?.length || 0) === 0
  }

  /**
   * Count faces in an image
  */
  async countFaces(image: Image): Promise<number> {
    const result = await this.detectFaces({
      Image: image,
      Attributes: ['DEFAULT'],
    })
    return result.FaceDetails?.length || 0
  }

  /**
   * Extract text from an image
  */
  async extractText(image: Image): Promise<string[]> {
    const result = await this.detectText({ Image: image })
    return result.TextDetections?.filter(t => t.Type === 'LINE').map(t => t.DetectedText || '') || []
  }

  /**
   * Find matching face in collection
  */
  async findFace(collectionId: string, image: Image, threshold: number = 80): Promise<FaceMatch | null> {
    try {
      const result = await this.searchFacesByImage({
        CollectionId: collectionId,
        Image: image,
        FaceMatchThreshold: threshold,
        MaxFaces: 1,
      })
      return result.FaceMatches?.[0] || null
    } catch (error: unknown) {
      // Face not found
      if (error instanceof Error && error.message.includes('InvalidParameterException')) {
        return null
      }
      throw error
    }
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Quick image label detection from S3
*/
export async function detectLabelsFromS3(
  bucket: string,
  key: string,
  options?: { region?: string; maxLabels?: number },
): Promise<string[]> {
  const client = new RekognitionClient(options?.region || 'us-east-1')
  const labels = await client.analyzeS3Image(bucket, key, { maxLabels: options?.maxLabels })
  return labels.map(l => l.Name || '').filter(Boolean)
}

/**
 * Quick face count from S3 image
*/
export async function countFacesInS3Image(
  bucket: string,
  key: string,
  region?: string,
): Promise<number> {
  const client = new RekognitionClient(region || 'us-east-1')
  return client.countFaces({ S3Object: { Bucket: bucket, Name: key } })
}

/**
 * Quick content moderation check
*/
export async function isContentSafe(
  bucket: string,
  key: string,
  options?: { region?: string; threshold?: number },
): Promise<boolean> {
  const client = new RekognitionClient(options?.region || 'us-east-1')
  return client.isImageSafe({ S3Object: { Bucket: bucket, Name: key } }, options?.threshold)
}
