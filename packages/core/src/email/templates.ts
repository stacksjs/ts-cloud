/**
 * SES Email Template Management
 * Template versioning, personalization, and testing
*/

export interface EmailTemplate {
  id: string
  name: string
  subject: string
  htmlPart: string
  textPart: string
  variables: string[]
  createdAt: Date
  updatedAt: Date
  version: number
}

export interface TemplateVersion {
  id: string
  templateId: string
  version: number
  subject: string
  htmlPart: string
  textPart: string
  createdAt: Date
  createdBy: string
  changelog?: string
}

export interface TemplateTest {
  id: string
  templateId: string
  testData: Record<string, any>
  renderedSubject: string
  renderedHtml: string
  renderedText: string
  timestamp: Date
}

/**
 * Email template manager
*/
export class EmailTemplateManager {
  private templates: Map<string, EmailTemplate> = new Map()
  private versions: Map<string, TemplateVersion[]> = new Map()
  private tests: Map<string, TemplateTest> = new Map()
  private templateCounter = 0
  private testCounter = 0

  /**
   * Create template
  */
  createTemplate(template: {
    name: string
    subject: string
    htmlPart: string
    textPart: string
  }): EmailTemplate {
    const id = `template-${Date.now()}-${this.templateCounter++}`

    const variables = this.extractVariables(template.subject + template.htmlPart + template.textPart)

    const emailTemplate: EmailTemplate = {
      id,
      variables,
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
      ...template,
    }

    this.templates.set(id, emailTemplate)

    // Store initial version
    this.addVersion({
      templateId: id,
      version: 1,
      subject: template.subject,
      htmlPart: template.htmlPart,
      textPart: template.textPart,
      createdBy: 'system',
    })

    return emailTemplate
  }

  /**
   * Create welcome email template
  */
  createWelcomeTemplate(options: {
    name: string
    companyName: string
  }): EmailTemplate {
    return this.createTemplate({
      name: options.name,
      subject: `Welcome to {{companyName}}!`,
      htmlPart: `
        <html>
          <body>
            <h1>Welcome, {{userName}}!</h1>
            <p>Thank you for joining {{companyName}}. We're excited to have you on board.</p>
            <p>Your account is now active and ready to use.</p>
            <a href="{{loginUrl}}">Get Started</a>
          </body>
        </html>
      `,
      textPart: `Welcome, {{userName}}! Thank you for joining {{companyName}}. Visit {{loginUrl}} to get started.`,
    })
  }

  /**
   * Create password reset template
  */
  createPasswordResetTemplate(options: {
    name: string
    companyName: string
  }): EmailTemplate {
    return this.createTemplate({
      name: options.name,
      subject: 'Reset your password',
      htmlPart: `
        <html>
          <body>
            <h1>Password Reset Request</h1>
            <p>Hi {{userName}},</p>
            <p>We received a request to reset your password for your {{companyName}} account.</p>
            <a href="{{resetUrl}}">Reset Password</a>
            <p>This link will expire in {{expirationHours}} hours.</p>
            <p>If you didn't request this, please ignore this email.</p>
          </body>
        </html>
      `,
      textPart: `Hi {{userName}}, reset your password at: {{resetUrl}}. This link expires in {{expirationHours}} hours.`,
    })
  }

  /**
   * Update template
  */
  updateTemplate(
    templateId: string,
    updates: {
      subject?: string
      htmlPart?: string
      textPart?: string
    },
    changelog?: string
  ): EmailTemplate {
    const template = this.templates.get(templateId)

    if (!template) {
      throw new Error(`Template not found: ${templateId}`)
    }

    if (updates.subject) template.subject = updates.subject
    if (updates.htmlPart) template.htmlPart = updates.htmlPart
    if (updates.textPart) template.textPart = updates.textPart

    template.version++
    template.updatedAt = new Date()
    template.variables = this.extractVariables(template.subject + template.htmlPart + template.textPart)

    // Store new version
    this.addVersion({
      templateId,
      version: template.version,
      subject: template.subject,
      htmlPart: template.htmlPart,
      textPart: template.textPart,
      createdBy: 'system',
      changelog,
    })

    return template
  }

  /**
   * Add template version
  */
  private addVersion(version: Omit<TemplateVersion, 'id' | 'createdAt'>): TemplateVersion {
    const id = `version-${version.templateId}-${version.version}`

    const templateVersion: TemplateVersion = {
      id,
      createdAt: new Date(),
      ...version,
    }

    const versions = this.versions.get(version.templateId) || []
    versions.push(templateVersion)
    this.versions.set(version.templateId, versions)

    return templateVersion
  }

  /**
   * Extract variables from template
  */
  private extractVariables(text: string): string[] {
    const regex = /\{\{([^}]+)\}\}/g
    const variables = new Set<string>()
    let match

    while ((match = regex.exec(text)) !== null) {
      variables.add(match[1].trim())
    }

    return Array.from(variables)
  }

  /**
   * Render template
  */
  renderTemplate(templateId: string, data: Record<string, any>): {
    subject: string
    html: string
    text: string
  } {
    const template = this.templates.get(templateId)

    if (!template) {
      throw new Error(`Template not found: ${templateId}`)
    }

    const render = (text: string): string => {
      return text.replace(/\{\{([^}]+)\}\}/g, (match, variable) => {
        const key = variable.trim()
        return data[key] !== undefined ? String(data[key]) : match
      })
    }

    return {
      subject: render(template.subject),
      html: render(template.htmlPart),
      text: render(template.textPart),
    }
  }

  /**
   * Test template
  */
  testTemplate(templateId: string, testData: Record<string, any>): TemplateTest {
    const id = `test-${Date.now()}-${this.testCounter++}`

    const rendered = this.renderTemplate(templateId, testData)

    const test: TemplateTest = {
      id,
      templateId,
      testData,
      renderedSubject: rendered.subject,
      renderedHtml: rendered.html,
      renderedText: rendered.text,
      timestamp: new Date(),
    }

    this.tests.set(id, test)

    return test
  }

  /**
   * Get template
  */
  getTemplate(id: string): EmailTemplate | undefined {
    return this.templates.get(id)
  }

  /**
   * List templates
  */
  listTemplates(): EmailTemplate[] {
    return Array.from(this.templates.values())
  }

  /**
   * Get template versions
  */
  getTemplateVersions(templateId: string): TemplateVersion[] {
    return this.versions.get(templateId) || []
  }

  /**
   * Revert to version
  */
  revertToVersion(templateId: string, versionNumber: number): EmailTemplate {
    const template = this.templates.get(templateId)

    if (!template) {
      throw new Error(`Template not found: ${templateId}`)
    }

    const versions = this.versions.get(templateId) || []
    const targetVersion = versions.find(v => v.version === versionNumber)

    if (!targetVersion) {
      throw new Error(`Version ${versionNumber} not found for template ${templateId}`)
    }

    template.subject = targetVersion.subject
    template.htmlPart = targetVersion.htmlPart
    template.textPart = targetVersion.textPart
    template.version++
    template.updatedAt = new Date()

    // Store revert as new version
    this.addVersion({
      templateId,
      version: template.version,
      subject: template.subject,
      htmlPart: template.htmlPart,
      textPart: template.textPart,
      createdBy: 'system',
      changelog: `Reverted to version ${versionNumber}`,
    })

    return template
  }

  /**
   * Generate CloudFormation for SES template
  */
  generateTemplateCF(template: EmailTemplate): any {
    return {
      Type: 'AWS::SES::Template',
      Properties: {
        Template: {
          TemplateName: template.name,
          SubjectPart: template.subject,
          HtmlPart: template.htmlPart,
          TextPart: template.textPart,
        },
      },
    }
  }

  /**
   * Clear all data
  */
  clear(): void {
    this.templates.clear()
    this.versions.clear()
    this.tests.clear()
    this.templateCounter = 0
    this.testCounter = 0
  }
}

/**
 * Global email template manager instance
*/
export const emailTemplateManager: EmailTemplateManager = new EmailTemplateManager()
