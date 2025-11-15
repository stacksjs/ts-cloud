import type { CloudFormationResource } from './index'

export interface SESEmailIdentity extends CloudFormationResource {
  Type: 'AWS::SES::EmailIdentity'
  Properties: {
    EmailIdentity: string
    DkimSigningAttributes?: {
      NextSigningKeyLength?: 'RSA_1024_BIT' | 'RSA_2048_BIT'
    }
    FeedbackAttributes?: {
      EmailForwardingEnabled?: boolean
    }
  }
}

export interface SESConfigurationSet extends CloudFormationResource {
  Type: 'AWS::SES::ConfigurationSet'
  Properties: {
    Name?: string
    ReputationOptions?: {
      ReputationMetricsEnabled?: boolean
    }
    SendingOptions?: {
      SendingEnabled?: boolean
    }
    SuppressionOptions?: {
      SuppressedReasons?: ('BOUNCE' | 'COMPLAINT')[]
    }
  }
}

export interface SESReceiptRuleSet extends CloudFormationResource {
  Type: 'AWS::SES::ReceiptRuleSet'
  Properties?: {
    RuleSetName?: string
  }
}

export interface SESReceiptRule extends CloudFormationResource {
  Type: 'AWS::SES::ReceiptRule'
  Properties: {
    RuleSetName: string | { Ref: string }
    Rule: {
      Name?: string
      Enabled?: boolean
      Recipients?: string[]
      ScanEnabled?: boolean
      TlsPolicy?: 'Optional' | 'Require'
      Actions?: Array<{
        S3Action?: {
          BucketName: string
          ObjectKeyPrefix?: string
          KmsKeyArn?: string
        }
        LambdaAction?: {
          FunctionArn: string
          InvocationType?: 'Event' | 'RequestResponse'
        }
        SNSAction?: {
          TopicArn: string
          Encoding?: 'UTF-8' | 'Base64'
        }
      }>
    }
  }
}
