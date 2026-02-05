import type { CloudConfig } from '@stacksjs/ts-cloud-types'

/**
 * WordPress Preset
 * Perfect for: WordPress sites, blogs, CMS-based sites
 * Includes: EC2 + RDS MySQL + EFS + CloudFront
*/
export function createWordPressPreset(options: {
  name: string
  slug: string
  domain: string
  instanceType?: string
}): Partial<CloudConfig> {
  const {
    name,
    slug,
    domain,
    instanceType = 't3.small',
  } = options

  return {
    project: {
      name,
      slug,
      region: 'us-east-1',
    },
    mode: 'server',
    environments: {
      production: {
        type: 'production',
        domain,
      },
    },
    infrastructure: {
      network: {
        vpc: {
          cidr: '10.0.0.0/16',
          availabilityZones: 2,
          natGateways: 1,
        },
      },
      compute: {
        server: {
          instanceType,
          ami: 'ubuntu-22.04',
          keyPair: `${slug}-key`,
          autoScaling: {
            min: 2,
            max: 6,
            desired: 2,
            targetCPU: 75,
          },
          loadBalancer: {
            type: 'application',
            healthCheck: {
              path: '/wp-admin/install.php',
              interval: 30,
            },
          },
          userData: {
            packages: ['nginx', 'php8.1-fpm', 'php8.1-mysql', 'php8.1-curl', 'php8.1-gd', 'php8.1-mbstring', 'php8.1-xml', 'php8.1-zip'],
            commands: [
              // Download WordPress
              'cd /var/www',
              'wget https://wordpress.org/latest.tar.gz',
              'tar -xzf latest.tar.gz',
              'chown -R www-data:www-data wordpress',
              // Configure Nginx
              'rm /etc/nginx/sites-enabled/default',
              'systemctl restart nginx',
              'systemctl restart php8.1-fpm',
            ],
          },
        },
      },
      // Shared file system for uploads
      fileSystem: {
        uploads: {
          performanceMode: 'generalPurpose',
          throughputMode: 'bursting',
          encrypted: true,
          lifecyclePolicy: {
            transitionToIA: 30, // Move to Infrequent Access after 30 days
          },
          mountPath: '/var/www/wordpress/wp-content/uploads',
        },
      },
      databases: {
        mysql: {
          engine: 'mysql',
          version: '8.0',
          instanceClass: 'db.t3.small',
          allocatedStorage: 50,
          multiAZ: true,
          backupRetentionDays: 7,
          deletionProtection: true,
          databaseName: 'wordpress',
        },
      },
      cache: {
        redis: {
          nodeType: 'cache.t3.micro',
          numCacheNodes: 1,
          engine: 'redis',
          engineVersion: '7.0',
        },
      },
      cdn: {
        enabled: true,
        customDomain: {
          domain,
          certificateArn: 'TO_BE_GENERATED',
        },
        cachePolicy: {
          minTTL: 0,
          defaultTTL: 86400,
          maxTTL: 31536000,
        },
        compress: true,
        origins: [{
          type: 'alb',
          pathPattern: '/wp-content/*',
        }],
      },
      security: {
        certificate: {
          domain,
          subdomains: [`www.${domain}`],
          validationMethod: 'DNS',
        },
        waf: {
          enabled: true,
          rules: ['rateLimit', 'sqlInjection', 'xss', 'wordpressRules'],
        },
      },
    },
  }
}
