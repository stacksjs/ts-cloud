/**
 * Email Templates with Stacks Views
 *
 * Provides template management and rendering
 */

export interface EmailTemplate {
  id: string
  name: string
  subject: string
  html: string
  text?: string
  variables: string[]
  category?: string
  createdAt: string
  updatedAt: string
  version: number
}

export interface TemplateRenderOptions {
  data: Record<string, any>
  locale?: string
  timezone?: string
}

/**
 * Email Templates Module
 */
export class EmailTemplates {
  /**
   * Lambda code for template rendering
   */
  static TemplateRendererCode = `
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({});
const TEMPLATE_BUCKET = process.env.TEMPLATE_BUCKET;

exports.handler = async (event) => {
  console.log('Template render request:', JSON.stringify(event, null, 2));

  try {
    const { templateId, data, locale, timezone } = JSON.parse(event.body || '{}');

    if (!templateId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing templateId' }),
      };
    }

    // Get template
    const templateKey = \`templates/\${templateId}.json\`;
    const result = await s3.send(new GetObjectCommand({
      Bucket: TEMPLATE_BUCKET,
      Key: templateKey,
    }));

    const template = JSON.parse(await result.Body.transformToString());

    // Render template
    const rendered = {
      subject: renderTemplate(template.subject, data),
      html: renderTemplate(template.html, data),
      text: template.text ? renderTemplate(template.text, data) : null,
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rendered),
    };
  } catch (error) {
    console.error('Error rendering template:', error);
    return {
      statusCode: error.name === 'NoSuchKey' ? 404 : 500,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

function renderTemplate(template, data) {
  if (!template || !data) return template;

  let result = template;

  // Handle {{variable}} syntax
  result = result.replace(/\\{\\{\\s*([\\w.]+)\\s*\\}\\}/g, (match, key) => {
    const value = getNestedValue(data, key);
    return value !== undefined ? String(value) : match;
  });

  // Handle {{#if condition}}...{{/if}} syntax
  result = result.replace(/\\{\\{#if\\s+([\\w.]+)\\}\\}([\\s\\S]*?)\\{\\{\\/if\\}\\}/g, (match, key, content) => {
    const value = getNestedValue(data, key);
    return value ? content : '';
  });

  // Handle {{#unless condition}}...{{/unless}} syntax
  result = result.replace(/\\{\\{#unless\\s+([\\w.]+)\\}\\}([\\s\\S]*?)\\{\\{\\/unless\\}\\}/g, (match, key, content) => {
    const value = getNestedValue(data, key);
    return !value ? content : '';
  });

  // Handle {{#each array}}...{{/each}} syntax
  result = result.replace(/\\{\\{#each\\s+([\\w.]+)\\}\\}([\\s\\S]*?)\\{\\{\\/each\\}\\}/g, (match, key, content) => {
    const array = getNestedValue(data, key);
    if (!Array.isArray(array)) return '';
    return array.map((item, index) => {
      let itemContent = content;
      itemContent = itemContent.replace(/\\{\\{this\\}\\}/g, String(item));
      itemContent = itemContent.replace(/\\{\\{@index\\}\\}/g, String(index));
      if (typeof item === 'object') {
        Object.entries(item).forEach(([k, v]) => {
          itemContent = itemContent.replace(new RegExp(\`\\\\{\\\\{\\\\s*\${k}\\\\s*\\\\}\\\\}\`, 'g'), String(v));
        });
      }
      return itemContent;
    }).join('');
  });

  return result;
}

function getNestedValue(obj, path) {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}
`

  /**
   * Built-in email templates
   */
  static BuiltInTemplates = {
    welcome: {
      id: 'welcome',
      name: 'Welcome Email',
      subject: 'Welcome to {{appName}}!',
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Welcome</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #2563eb;">Welcome to {{appName}}!</h1>
  </div>
  
  <p>Hi {{userName}},</p>
  
  <p>Thank you for joining {{appName}}! We're excited to have you on board.</p>
  
  {{#if verificationUrl}}
  <div style="text-align: center; margin: 30px 0;">
    <a href="{{verificationUrl}}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Verify Your Email</a>
  </div>
  {{/if}}
  
  <p>If you have any questions, feel free to reply to this email.</p>
  
  <p>Best regards,<br>The {{appName}} Team</p>
  
  <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
  <p style="font-size: 12px; color: #666;">
    You received this email because you signed up for {{appName}}.
  </p>
</body>
</html>`,
      text: `Welcome to {{appName}}!

Hi {{userName}},

Thank you for joining {{appName}}! We're excited to have you on board.

{{#if verificationUrl}}
Verify your email: {{verificationUrl}}
{{/if}}

If you have any questions, feel free to reply to this email.

Best regards,
The {{appName}} Team`,
      variables: ['appName', 'userName', 'verificationUrl'] as const,
      category: 'onboarding',
    },

    passwordReset: {
      id: 'password-reset',
      name: 'Password Reset',
      subject: 'Reset your {{appName}} password',
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #2563eb;">Password Reset Request</h1>
  
  <p>Hi {{userName}},</p>
  
  <p>We received a request to reset your password. Click the button below to create a new password:</p>
  
  <div style="text-align: center; margin: 30px 0;">
    <a href="{{resetUrl}}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Reset Password</a>
  </div>
  
  <p>This link will expire in {{expiresIn}}.</p>
  
  <p>If you didn't request this, you can safely ignore this email.</p>
  
  <p>Best regards,<br>The {{appName}} Team</p>
</body>
</html>`,
      text: `Password Reset Request

Hi {{userName}},

We received a request to reset your password. Visit the link below to create a new password:

{{resetUrl}}

This link will expire in {{expiresIn}}.

If you didn't request this, you can safely ignore this email.

Best regards,
The {{appName}} Team`,
      variables: ['appName', 'userName', 'resetUrl', 'expiresIn'] as const,
      category: 'auth',
    },

    notification: {
      id: 'notification',
      name: 'Notification',
      subject: '{{subject}}',
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #2563eb;">{{title}}</h1>
  
  <p>{{message}}</p>
  
  {{#if actionUrl}}
  <div style="text-align: center; margin: 30px 0;">
    <a href="{{actionUrl}}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">{{actionText}}</a>
  </div>
  {{/if}}
  
  <p style="font-size: 12px; color: #666; margin-top: 30px;">
    — {{appName}}
  </p>
</body>
</html>`,
      text: `{{title}}

{{message}}

{{#if actionUrl}}
{{actionText}}: {{actionUrl}}
{{/if}}

— {{appName}}`,
      variables: ['subject', 'title', 'message', 'actionUrl', 'actionText', 'appName'] as const,
      category: 'notification',
    },

    invoice: {
      id: 'invoice',
      name: 'Invoice',
      subject: 'Invoice #{{invoiceNumber}} from {{appName}}',
      html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="color: #2563eb;">Invoice #{{invoiceNumber}}</h1>
  
  <p>Hi {{customerName}},</p>
  
  <p>Here's your invoice for {{period}}.</p>
  
  <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
    <thead>
      <tr style="background-color: #f3f4f6;">
        <th style="padding: 10px; text-align: left; border-bottom: 1px solid #e5e7eb;">Item</th>
        <th style="padding: 10px; text-align: right; border-bottom: 1px solid #e5e7eb;">Amount</th>
      </tr>
    </thead>
    <tbody>
      {{#each items}}
      <tr>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">{{description}}</td>
        <td style="padding: 10px; text-align: right; border-bottom: 1px solid #e5e7eb;">{{amount}}</td>
      </tr>
      {{/each}}
    </tbody>
    <tfoot>
      <tr>
        <td style="padding: 10px; font-weight: bold;">Total</td>
        <td style="padding: 10px; text-align: right; font-weight: bold;">{{total}}</td>
      </tr>
    </tfoot>
  </table>
  
  {{#if paymentUrl}}
  <div style="text-align: center; margin: 30px 0;">
    <a href="{{paymentUrl}}" style="background-color: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Pay Now</a>
  </div>
  {{/if}}
  
  <p>Thank you for your business!</p>
  
  <p>Best regards,<br>The {{appName}} Team</p>
</body>
</html>`,
      variables: ['invoiceNumber', 'customerName', 'period', 'items', 'total', 'paymentUrl', 'appName'] as const,
      category: 'billing',
    },
  }

  /**
   * Create template storage bucket
   */
  static createTemplateBucket(config: { slug: string }): Record<string, any> {
    return {
      [`${config.slug}EmailTemplateBucket`]: {
        Type: 'AWS::S3::Bucket',
        Properties: {
          BucketName: `${config.slug}-email-templates`,
          VersioningConfiguration: {
            Status: 'Enabled',
          },
        },
      },
    }
  }

  /**
   * Create template renderer Lambda
   */
  static createTemplateRendererLambda(config: {
    slug: string
    roleArn: string
    templateBucket: string
  }): Record<string, any> {
    return {
      [`${config.slug}TemplateRendererLambda`]: {
        Type: 'AWS::Lambda::Function',
        Properties: {
          FunctionName: `${config.slug}-template-renderer`,
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: config.roleArn,
          Timeout: 30,
          MemorySize: 256,
          Code: {
            ZipFile: EmailTemplates.TemplateRendererCode,
          },
          Environment: {
            Variables: {
              TEMPLATE_BUCKET: config.templateBucket,
            },
          },
        },
      },
    }
  }

  /**
   * Render a template with data (SDK helper)
   */
  static render(template: string, data: Record<string, any>): string {
    if (!template || !data) return template

    let result = template

    // Handle {{variable}} syntax
    result = result.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
      const value = EmailTemplates.getNestedValue(data, key)
      return value !== undefined ? String(value) : match
    })

    // Handle {{#if condition}}...{{/if}} syntax
    result = result.replace(/\{\{#if\s+([\w.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (match, key, content) => {
      const value = EmailTemplates.getNestedValue(data, key)
      return value ? content : ''
    })

    // Handle {{#unless condition}}...{{/unless}} syntax
    result = result.replace(/\{\{#unless\s+([\w.]+)\}\}([\s\S]*?)\{\{\/unless\}\}/g, (match, key, content) => {
      const value = EmailTemplates.getNestedValue(data, key)
      return !value ? content : ''
    })

    // Handle {{#each array}}...{{/each}} syntax
    result = result.replace(/\{\{#each\s+([\w.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (match, key, content) => {
      const array = EmailTemplates.getNestedValue(data, key)
      if (!Array.isArray(array)) return ''
      return array.map((item, index) => {
        let itemContent = content
        itemContent = itemContent.replace(/\{\{this\}\}/g, String(item))
        itemContent = itemContent.replace(/\{\{@index\}\}/g, String(index))
        if (typeof item === 'object') {
          Object.entries(item).forEach(([k, v]) => {
            itemContent = itemContent.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, 'g'), String(v))
          })
        }
        return itemContent
      }).join('')
    })

    return result
  }

  private static getNestedValue(obj: Record<string, any>, path: string): any {
    return path.split('.').reduce((current, key) => current?.[key], obj)
  }

  /**
   * Extract variables from template
   */
  static extractVariables(template: string): string[] {
    const variables = new Set<string>()

    // Match {{variable}}
    const matches = template.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)
    for (const match of matches) {
      if (!match[1].startsWith('#') && !match[1].startsWith('/') && !match[1].startsWith('@')) {
        variables.add(match[1].split('.')[0])
      }
    }

    // Match {{#if variable}}
    const ifMatches = template.matchAll(/\{\{#(?:if|unless|each)\s+([\w.]+)\}\}/g)
    for (const match of ifMatches) {
      variables.add(match[1].split('.')[0])
    }

    return Array.from(variables)
  }
}

export default EmailTemplates
