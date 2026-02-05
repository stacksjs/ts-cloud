/**
 * Voicemail Lambda Handler
 *
 * Processes voicemail recordings:
 * - Processes voicemail recordings from S3
 * - Transcribes using Amazon Transcribe
 * - Sends notification with transcription
*/

export const handler = `
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { TranscribeClient, StartTranscriptionJobCommand, GetTranscriptionJobCommand } = require('@aws-sdk/client-transcribe');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

const s3 = new S3Client({});
const transcribe = new TranscribeClient({});
const sns = new SNSClient({});
const dynamodb = new DynamoDBClient({});

exports.handler = async (event) => {
  console.log('Voicemail event:', JSON.stringify(event, null, 2));

  const notificationTopicArn = process.env.NOTIFICATION_TOPIC_ARN;
  const voicemailBucket = process.env.VOICEMAIL_BUCKET;
  const callLogTable = process.env.CALL_LOG_TABLE;
  const transcriptionEnabled = process.env.TRANSCRIPTION_ENABLED === 'true';

  for (const record of event.Records) {
    try {
      const s3Event = record.s3 || {};
      const bucket = s3Event.bucket?.name || voicemailBucket;
      const key = decodeURIComponent(s3Event.object?.key?.replace(/\\+/g, ' ') || '');

      if (!key.includes('voicemail') || !key.endsWith('.wav')) {
        continue;
      }

      console.log(\`Processing voicemail: \${key}\`);

      // Extract metadata from key (format: voicemails/{contactId}/{timestamp}.wav)
      const parts = key.split('/');
      const contactId = parts[1] || 'unknown';
      const filename = parts[parts.length - 1];
      const timestamp = filename.replace('.wav', '');

      // Get voicemail metadata if exists
      let metadata = {};
      try {
        const metaResult = await s3.send(new GetObjectCommand({
          Bucket: bucket,
          Key: key.replace('.wav', '.json'),
        }));
        metadata = JSON.parse(await metaResult.Body.transformToString());
      } catch {
        // No metadata file
      }

      let transcription = null;

      // Start transcription if enabled
      if (transcriptionEnabled) {
        const jobName = \`voicemail-\${contactId}-\${Date.now()}\`;

        await transcribe.send(new StartTranscriptionJobCommand({
          TranscriptionJobName: jobName,
          LanguageCode: 'en-US',
          MediaFormat: 'wav',
          Media: {
            MediaFileUri: \`s3://\${bucket}/\${key}\`,
          },
          OutputBucketName: bucket,
          OutputKey: key.replace('.wav', '-transcript.json'),
        }));

        // Wait for transcription (with timeout)
        let attempts = 0;
        const maxAttempts = 30; // 5 minutes max

        while (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 10000)); // 10 seconds

          const jobResult = await transcribe.send(new GetTranscriptionJobCommand({
            TranscriptionJobName: jobName,
          }));

          const status = jobResult.TranscriptionJob?.TranscriptionJobStatus;

          if (status === 'COMPLETED') {
            // Get transcription result
            try {
              const transcriptResult = await s3.send(new GetObjectCommand({
                Bucket: bucket,
                Key: key.replace('.wav', '-transcript.json'),
              }));
              const transcriptData = JSON.parse(await transcriptResult.Body.transformToString());
              transcription = transcriptData.results?.transcripts?.[0]?.transcript || '';
            } catch (err) {
              console.error('Error getting transcription:', err.message);
            }
            break;
          } else if (status === 'FAILED') {
            console.error('Transcription failed');
            break;
          }

          attempts++;
        }
      }

      // Update call log
      if (callLogTable && contactId !== 'unknown') {
        await dynamodb.send(new UpdateItemCommand({
          TableName: callLogTable,
          Key: {
            contactId: { S: contactId },
          },
          UpdateExpression: 'SET voicemailKey = :key, voicemailTranscript = :transcript, voicemailAt = :at',
          ExpressionAttributeValues: {
            ':key': { S: key },
            ':transcript': { S: transcription || '' },
            ':at': { S: new Date().toISOString() },
          },
        }));
      }

      // Save voicemail metadata
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key.replace('.wav', '-metadata.json'),
        Body: JSON.stringify({
          contactId,
          callerNumber: metadata.callerNumber || 'unknown',
          calledNumber: metadata.calledNumber || 'unknown',
          duration: metadata.duration || 0,
          recordedAt: timestamp,
          processedAt: new Date().toISOString(),
          transcription,
          audioKey: key,
        }, null, 2),
        ContentType: 'application/json',
      }));

      // Send notification
      if (notificationTopicArn) {
        await sns.send(new PublishCommand({
          TopicArn: notificationTopicArn,
          Subject: 'New Voicemail',
          Message: JSON.stringify({
            type: 'voicemail',
            contactId,
            from: metadata.callerNumber || 'unknown',
            to: metadata.calledNumber || 'unknown',
            duration: metadata.duration || 0,
            transcription: transcription || '(transcription not available)',
            audioUrl: \`s3://\${bucket}/\${key}\`,
            timestamp: new Date().toISOString(),
          }, null, 2),
          MessageAttributes: {
            eventType: {
              DataType: 'String',
              StringValue: 'voicemail',
            },
          },
        }));
      }

      console.log(\`Processed voicemail: \${contactId}\`);

    } catch (error) {
      console.error('Error processing voicemail:', error);
    }
  }

  return { statusCode: 200, body: 'OK' };
};
`

export default handler
