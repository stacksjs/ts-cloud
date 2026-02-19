import { describe, expect, test } from 'bun:test'
import { Auth } from '../src/modules/auth'
import { TemplateBuilder } from '../src/template-builder'
import type { EnvironmentType } from 'ts-cloud-types'

const slug = 'test-app'
const environment: EnvironmentType = 'development'

describe('auth Module - User Pool', () => {
  test('should create a basic user pool', () => {
    const { userPool, logicalId } = Auth.createUserPool({
      slug,
      environment,
    })

    expect(userPool.Type).toBe('AWS::Cognito::UserPool')
    expect(userPool.Properties?.UserPoolName).toContain('test-app')
    expect(logicalId).toBeTruthy()
  })

  test('should create a user pool with custom name', () => {
    const { userPool } = Auth.createUserPool({
      slug,
      environment,
      userPoolName: 'my-custom-pool',
    })

    expect(userPool.Properties?.UserPoolName).toBe('my-custom-pool')
  })

  test('should create a user pool with alias attributes', () => {
    const { userPool } = Auth.createUserPool({
      slug,
      environment,
      aliasAttributes: ['email', 'phone_number'],
    })

    expect(userPool.Properties?.UsernameAttributes).toEqual(['email', 'phone_number'])
  })

  test('should create a user pool with auto-verified attributes', () => {
    const { userPool } = Auth.createUserPool({
      slug,
      environment,
      autoVerifiedAttributes: ['email'],
    })

    expect(userPool.Properties?.AutoVerifiedAttributes).toEqual(['email'])
  })

  test('should create a user pool with password policy', () => {
    const { userPool } = Auth.createUserPool({
      slug,
      environment,
      passwordPolicy: {
        minimumLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireNumbers: true,
        requireSymbols: true,
        temporaryPasswordValidityDays: 7,
      },
    })

    expect(userPool.Properties?.Policies?.PasswordPolicy?.MinimumLength).toBe(12)
    expect(userPool.Properties?.Policies?.PasswordPolicy?.RequireLowercase).toBe(true)
    expect(userPool.Properties?.Policies?.PasswordPolicy?.RequireUppercase).toBe(true)
    expect(userPool.Properties?.Policies?.PasswordPolicy?.RequireNumbers).toBe(true)
    expect(userPool.Properties?.Policies?.PasswordPolicy?.RequireSymbols).toBe(true)
  })

  test('should create a user pool with MFA configuration', () => {
    const { userPool } = Auth.createUserPool({
      slug,
      environment,
      mfaConfiguration: 'OPTIONAL',
    })

    expect(userPool.Properties?.MfaConfiguration).toBe('OPTIONAL')
  })

  test('should create a user pool with email configuration', () => {
    const { userPool } = Auth.createUserPool({
      slug,
      environment,
      emailConfiguration: {
        emailSendingAccount: 'DEVELOPER',
        from: 'noreply@example.com',
        replyToEmailAddress: 'support@example.com',
        sourceArn: 'arn:aws:ses:us-east-1:123456789012:identity/example.com',
      },
    })

    expect(userPool.Properties?.EmailConfiguration?.EmailSendingAccount).toBe('DEVELOPER')
    expect(userPool.Properties?.EmailConfiguration?.From).toBe('noreply@example.com')
    expect(userPool.Properties?.EmailConfiguration?.ReplyToEmailAddress).toBe('support@example.com')
  })

  test('should create a user pool with Lambda triggers', () => {
    const { userPool } = Auth.createUserPool({
      slug,
      environment,
      lambdaTriggers: {
        preSignUp: 'arn:aws:lambda:us-east-1:123456789012:function:pre-signup',
        postConfirmation: 'arn:aws:lambda:us-east-1:123456789012:function:post-confirmation',
      },
    })

    expect(userPool.Properties?.LambdaConfig?.PreSignUp).toBe('arn:aws:lambda:us-east-1:123456789012:function:pre-signup')
    expect(userPool.Properties?.LambdaConfig?.PostConfirmation).toBe('arn:aws:lambda:us-east-1:123456789012:function:post-confirmation')
  })

  test('should create a user pool with advanced security mode', () => {
    const { userPool } = Auth.createUserPool({
      slug,
      environment,
      userPoolAddOns: {
        advancedSecurityMode: 'ENFORCED',
      },
    })

    expect(userPool.Properties?.UserPoolAddOns?.AdvancedSecurityMode).toBe('ENFORCED')
  })

  test('should create a user pool with account recovery settings', () => {
    const { userPool } = Auth.createUserPool({
      slug,
      environment,
      accountRecoverySetting: {
        recoveryMechanisms: [
          { Name: 'verified_email', Priority: 1 },
          { Name: 'verified_phone_number', Priority: 2 },
        ],
      },
    })

    expect(userPool.Properties?.AccountRecoverySetting?.RecoveryMechanisms).toHaveLength(2)
    expect(userPool.Properties?.AccountRecoverySetting?.RecoveryMechanisms?.[0].Name).toBe('verified_email')
  })
})

describe('auth Module - User Pool Client', () => {
  test('should create a basic user pool client', () => {
    const { logicalId: poolId } = Auth.createUserPool({
      slug,
      environment,
    })

    const { client, logicalId } = Auth.createUserPoolClient(poolId, {
      slug,
      environment,
    })

    expect(client.Type).toBe('AWS::Cognito::UserPoolClient')
    expect(client.Properties?.ClientName).toContain('test-app')
    expect(logicalId).toBeTruthy()
  })

  test('should create a client with custom name', () => {
    const { logicalId: poolId } = Auth.createUserPool({
      slug,
      environment,
    })

    const { client } = Auth.createUserPoolClient(poolId, {
      slug,
      environment,
      clientName: 'my-app-client',
    })

    expect(client.Properties?.ClientName).toBe('my-app-client')
  })

  test('should create a client with secret', () => {
    const { logicalId: poolId } = Auth.createUserPool({
      slug,
      environment,
    })

    const { client } = Auth.createUserPoolClient(poolId, {
      slug,
      environment,
      generateSecret: true,
    })

    expect(client.Properties?.GenerateSecret).toBe(true)
  })

  test('should create a client with token validity', () => {
    const { logicalId: poolId } = Auth.createUserPool({
      slug,
      environment,
    })

    const { client } = Auth.createUserPoolClient(poolId, {
      slug,
      environment,
      refreshTokenValidity: 30,
      accessTokenValidity: 60,
      idTokenValidity: 60,
      tokenValidityUnits: {
        RefreshToken: 'days',
        AccessToken: 'minutes',
        IdToken: 'minutes',
      },
    })

    expect(client.Properties?.RefreshTokenValidity).toBe(30)
    expect(client.Properties?.AccessTokenValidity).toBe(60)
    expect(client.Properties?.IdTokenValidity).toBe(60)
    expect(client.Properties?.TokenValidityUnits?.RefreshToken).toBe('days')
  })

  test('should create a client with explicit auth flows', () => {
    const { logicalId: poolId } = Auth.createUserPool({
      slug,
      environment,
    })

    const { client } = Auth.createUserPoolClient(poolId, {
      slug,
      environment,
      explicitAuthFlows: [...Auth.AuthFlows.standard],
    })

    expect(client.Properties?.ExplicitAuthFlows).toContain('ALLOW_USER_SRP_AUTH')
    expect(client.Properties?.ExplicitAuthFlows).toContain('ALLOW_REFRESH_TOKEN_AUTH')
  })

  test('should create a client with OAuth configuration', () => {
    const { logicalId: poolId } = Auth.createUserPool({
      slug,
      environment,
    })

    const { client } = Auth.createUserPoolClient(poolId, {
      slug,
      environment,
      callbackURLs: ['https://example.com/callback'],
      logoutURLs: ['https://example.com/logout'],
      allowedOAuthFlows: ['code'],
      allowedOAuthScopes: [...Auth.OAuthScopes.basic],
      allowedOAuthFlowsUserPoolClient: true,
    })

    expect(client.Properties?.CallbackURLs).toEqual(['https://example.com/callback'])
    expect(client.Properties?.LogoutURLs).toEqual(['https://example.com/logout'])
    expect(client.Properties?.AllowedOAuthFlows).toEqual(['code'])
    expect(client.Properties?.AllowedOAuthScopes).toContain('openid')
  })

  test('should create a client with token revocation enabled', () => {
    const { logicalId: poolId } = Auth.createUserPool({
      slug,
      environment,
    })

    const { client } = Auth.createUserPoolClient(poolId, {
      slug,
      environment,
      enableTokenRevocation: true,
    })

    expect(client.Properties?.EnableTokenRevocation).toBe(true)
  })
})

describe('auth Module - User Pool Domain', () => {
  test('should create a user pool domain', () => {
    const { logicalId: poolId } = Auth.createUserPool({
      slug,
      environment,
    })

    const { domain, logicalId } = Auth.createUserPoolDomain(poolId, {
      slug,
      environment,
      domain: 'my-app-auth',
    })

    expect(domain.Type).toBe('AWS::Cognito::UserPoolDomain')
    expect(domain.Properties?.Domain).toBe('my-app-auth')
    expect(logicalId).toBeTruthy()
  })

  test('should create a custom domain', () => {
    const { logicalId: poolId } = Auth.createUserPool({
      slug,
      environment,
    })

    const { domain } = Auth.createUserPoolDomain(poolId, {
      slug,
      environment,
      domain: 'auth.example.com',
      customDomainConfig: {
        CertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/12345678',
      },
    })

    expect(domain.Properties?.Domain).toBe('auth.example.com')
    expect(domain.Properties?.CustomDomainConfig?.CertificateArn).toBeTruthy()
  })
})

describe('auth Module - Identity Pool', () => {
  test('should create a basic identity pool', () => {
    const { identityPool, logicalId } = Auth.createIdentityPool({
      slug,
      environment,
    })

    expect(identityPool.Type).toBe('AWS::Cognito::IdentityPool')
    expect(identityPool.Properties?.IdentityPoolName).toContain('test-app')
    expect(identityPool.Properties?.AllowUnauthenticatedIdentities).toBe(false)
    expect(logicalId).toBeTruthy()
  })

  test('should create an identity pool with custom name', () => {
    const { identityPool } = Auth.createIdentityPool({
      slug,
      environment,
      identityPoolName: 'my-identity-pool',
    })

    expect(identityPool.Properties?.IdentityPoolName).toBe('my-identity-pool')
  })

  test('should create an identity pool allowing unauthenticated access', () => {
    const { identityPool } = Auth.createIdentityPool({
      slug,
      environment,
      allowUnauthenticatedIdentities: true,
    })

    expect(identityPool.Properties?.AllowUnauthenticatedIdentities).toBe(true)
  })

  test('should create an identity pool with Cognito provider', () => {
    const { identityPool } = Auth.createIdentityPool({
      slug,
      environment,
      cognitoIdentityProviders: [
        {
          ClientId: 'abc123',
          ProviderName: 'cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123',
        },
      ],
    })

    expect(identityPool.Properties?.CognitoIdentityProviders).toHaveLength(1)
    expect(identityPool.Properties?.CognitoIdentityProviders?.[0].ClientId).toBe('abc123')
  })

  test('should create an identity pool with social providers', () => {
    const { identityPool } = Auth.createIdentityPool({
      slug,
      environment,
      supportedLoginProviders: {
        'accounts.google.com': 'google-client-id',
        'graph.facebook.com': 'facebook-app-id',
      },
    })

    expect(identityPool.Properties?.SupportedLoginProviders).toBeDefined()
    expect(identityPool.Properties?.SupportedLoginProviders?.['accounts.google.com']).toBe('google-client-id')
  })
})

describe('auth Module - Identity Pool Roles', () => {
  test('should create authenticated role', () => {
    const { logicalId: identityPoolId } = Auth.createIdentityPool({
      slug,
      environment,
    })

    const { role, logicalId } = Auth.createAuthenticatedRole({
      slug,
      environment,
      identityPoolLogicalId: identityPoolId,
    })

    expect(role.Type).toBe('AWS::IAM::Role')
    expect(role.Properties?.RoleName).toContain('cognito-authenticated-role')
    expect(role.Properties?.AssumeRolePolicyDocument?.Statement?.[0].Principal?.Federated).toBe('cognito-identity.amazonaws.com')
    expect(logicalId).toBeTruthy()
  })

  test('should create unauthenticated role', () => {
    const { logicalId: identityPoolId } = Auth.createIdentityPool({
      slug,
      environment,
    })

    const { role, logicalId } = Auth.createUnauthenticatedRole({
      slug,
      environment,
      identityPoolLogicalId: identityPoolId,
    })

    expect(role.Type).toBe('AWS::IAM::Role')
    expect(role.Properties?.RoleName).toContain('cognito-unauthenticated-role')
    expect(logicalId).toBeTruthy()
  })

  test('should create identity pool role attachment', () => {
    const { logicalId: identityPoolId } = Auth.createIdentityPool({
      slug,
      environment,
    })

    const { attachment, logicalId } = Auth.createIdentityPoolRoleAttachment(identityPoolId, {
      slug,
      environment,
      authenticatedRole: 'arn:aws:iam::123456789012:role/Cognito_AuthRole',
      unauthenticatedRole: 'arn:aws:iam::123456789012:role/Cognito_UnauthRole',
    })

    expect(attachment.Type).toBe('AWS::Cognito::IdentityPoolRoleAttachment')
    expect(attachment.Properties?.Roles?.authenticated).toBeTruthy()
    expect(attachment.Properties?.Roles?.unauthenticated).toBeTruthy()
    expect(logicalId).toBeTruthy()
  })
})

describe('auth Module - Password Policies', () => {
  test('should have relaxed password policy', () => {
    const policy = Auth.PasswordPolicies.relaxed()

    expect(policy.minimumLength).toBe(8)
    expect(policy.requireLowercase).toBe(false)
    expect(policy.requireUppercase).toBe(false)
    expect(policy.requireNumbers).toBe(false)
    expect(policy.requireSymbols).toBe(false)
  })

  test('should have standard password policy', () => {
    const policy = Auth.PasswordPolicies.standard()

    expect(policy.minimumLength).toBe(8)
    expect(policy.requireLowercase).toBe(true)
    expect(policy.requireUppercase).toBe(true)
    expect(policy.requireNumbers).toBe(true)
    expect(policy.requireSymbols).toBe(false)
  })

  test('should have strict password policy', () => {
    const policy = Auth.PasswordPolicies.strict()

    expect(policy.minimumLength).toBe(12)
    expect(policy.requireLowercase).toBe(true)
    expect(policy.requireUppercase).toBe(true)
    expect(policy.requireNumbers).toBe(true)
    expect(policy.requireSymbols).toBe(true)
  })
})

describe('auth Module - Auth Flows', () => {
  test('should have standard auth flows', () => {
    expect(Auth.AuthFlows.standard).toContain('ALLOW_USER_SRP_AUTH')
    expect(Auth.AuthFlows.standard).toContain('ALLOW_REFRESH_TOKEN_AUTH')
  })

  test('should have admin auth flows', () => {
    expect(Auth.AuthFlows.admin).toContain('ALLOW_ADMIN_USER_PASSWORD_AUTH')
    expect(Auth.AuthFlows.admin).toContain('ALLOW_REFRESH_TOKEN_AUTH')
  })

  test('should have custom auth flows', () => {
    expect(Auth.AuthFlows.custom).toContain('ALLOW_CUSTOM_AUTH')
    expect(Auth.AuthFlows.custom).toContain('ALLOW_REFRESH_TOKEN_AUTH')
  })
})

describe('auth Module - OAuth Scopes', () => {
  test('should have basic OAuth scopes', () => {
    expect(Auth.OAuthScopes.basic).toContain('openid')
    expect(Auth.OAuthScopes.basic).toContain('email')
    expect(Auth.OAuthScopes.basic).toContain('profile')
  })

  test('should have all OAuth scopes', () => {
    expect(Auth.OAuthScopes.all).toContain('openid')
    expect(Auth.OAuthScopes.all).toContain('email')
    expect(Auth.OAuthScopes.all).toContain('profile')
    expect(Auth.OAuthScopes.all).toContain('phone')
    expect(Auth.OAuthScopes.all).toContain('aws.cognito.signin.user.admin')
  })
})

describe('auth Module - Use Cases', () => {
  test('should create web app authentication setup', () => {
    const { userPool, poolId, client, clientId } = Auth.UseCases.webApp(
      slug,
      environment,
      'https://example.com/callback',
    )

    expect(userPool.Type).toBe('AWS::Cognito::UserPool')
    expect(client.Type).toBe('AWS::Cognito::UserPoolClient')
    expect(client.Properties?.AllowedOAuthFlows).toContain('code')
    expect(client.Properties?.CallbackURLs).toContain('https://example.com/callback')
    expect(poolId).toBeTruthy()
    expect(clientId).toBeTruthy()
  })

  test('should create mobile app authentication setup', () => {
    const {
      userPool,
      poolId,
      client,
      clientId,
      identityPool,
      identityPoolId,
      authRole,
      authRoleId,
      attachment,
      attachmentId,
    } = Auth.UseCases.mobileApp(slug, environment)

    expect(userPool.Type).toBe('AWS::Cognito::UserPool')
    expect(client.Type).toBe('AWS::Cognito::UserPoolClient')
    expect(identityPool.Type).toBe('AWS::Cognito::IdentityPool')
    expect(authRole.Type).toBe('AWS::IAM::Role')
    expect(attachment.Type).toBe('AWS::Cognito::IdentityPoolRoleAttachment')
    expect(poolId).toBeTruthy()
    expect(clientId).toBeTruthy()
    expect(identityPoolId).toBeTruthy()
    expect(authRoleId).toBeTruthy()
    expect(attachmentId).toBeTruthy()
  })
})

describe('auth Module - Integration with TemplateBuilder', () => {
  test('should add user pool to template', () => {
    const builder = new TemplateBuilder()

    const { userPool, logicalId } = Auth.createUserPool({
      slug,
      environment,
      passwordPolicy: Auth.PasswordPolicies.standard(),
      mfaConfiguration: 'OPTIONAL',
    })

    builder.addResource(logicalId, userPool)

    const template = builder.build()

    expect(template.Resources[logicalId]).toBeDefined()
    expect(template.Resources[logicalId].Type).toBe('AWS::Cognito::UserPool')
  })

  test('should add complete authentication stack to template', () => {
    const builder = new TemplateBuilder()

    const { userPool, logicalId: poolId } = Auth.createUserPool({
      slug,
      environment,
      aliasAttributes: ['email'],
      autoVerifiedAttributes: ['email'],
      passwordPolicy: Auth.PasswordPolicies.standard(),
    })

    const { client, logicalId: clientId } = Auth.createUserPoolClient(poolId, {
      slug,
      environment,
      explicitAuthFlows: [...Auth.AuthFlows.standard],
    })

    const { domain, logicalId: domainId } = Auth.createUserPoolDomain(poolId, {
      slug,
      environment,
      domain: 'my-app-auth',
    })

    builder.addResource(poolId, userPool)
    builder.addResource(clientId, client)
    builder.addResource(domainId, domain)

    const template = builder.build()

    expect(Object.keys(template.Resources)).toHaveLength(3)
    expect(template.Resources[poolId].Type).toBe('AWS::Cognito::UserPool')
    expect(template.Resources[clientId].Type).toBe('AWS::Cognito::UserPoolClient')
    expect(template.Resources[domainId].Type).toBe('AWS::Cognito::UserPoolDomain')
  })

  test('should add identity pool stack to template', () => {
    const builder = new TemplateBuilder()

    const { identityPool, logicalId: identityPoolId } = Auth.createIdentityPool({
      slug,
      environment,
      allowUnauthenticatedIdentities: false,
    })

    const { role: authRole, logicalId: authRoleId } = Auth.createAuthenticatedRole({
      slug,
      environment,
      identityPoolLogicalId: identityPoolId,
    })

    const { role: unauthRole, logicalId: unauthRoleId } = Auth.createUnauthenticatedRole({
      slug,
      environment,
      identityPoolLogicalId: identityPoolId,
    })

    const { attachment, logicalId: attachmentId } = Auth.createIdentityPoolRoleAttachment(
      identityPoolId,
      {
        slug,
        environment,
        authenticatedRole: `\${${authRoleId}.Arn}`,
        unauthenticatedRole: `\${${unauthRoleId}.Arn}`,
      },
    )

    builder.addResource(identityPoolId, identityPool)
    builder.addResource(authRoleId, authRole)
    builder.addResource(unauthRoleId, unauthRole)
    builder.addResource(attachmentId, attachment)

    const template = builder.build()

    expect(Object.keys(template.Resources)).toHaveLength(4)
    expect(template.Resources[identityPoolId].Type).toBe('AWS::Cognito::IdentityPool')
    expect(template.Resources[authRoleId].Type).toBe('AWS::IAM::Role')
    expect(template.Resources[unauthRoleId].Type).toBe('AWS::IAM::Role')
    expect(template.Resources[attachmentId].Type).toBe('AWS::Cognito::IdentityPoolRoleAttachment')
  })
})
