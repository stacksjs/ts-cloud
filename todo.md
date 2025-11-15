# TS Cloud - Development Roadmap

A lightweight, performant infrastructure-as-code library and CLI for deploying both **server-based (EC2)** and **serverless** applications. Built with Bun, generates pure CloudFormation (no heavy SDKs), inspired by Laravel Forge + Vapor unified.

---

## Phase 1: Core Architecture & Foundation

### 1.1 Project Structure

- [ ] Set up monorepo structure with workspaces (check our current boilerplate ./packages/* for structure)
  - [ ] `/packages/core` - Core library (CloudFormation generator)
  - [ ] `/packages/cli` - CLI interface
  - [ ] `/packages/types` - Shared TypeScript types
  - [ ] `/packages/aws-types` - AWS CloudFormation resource type definitions
- [ ] Configure Bun build pipeline
- [ ] Set up TypeScript with strict mode
- [ ] Configure path aliases for clean imports
- [ ] Set up Biome/ESLint for code quality
- [ ] Create initial package.json for each workspace

### 1.2 Type System Design

- [ ] Define core configuration types (CloudConfig, SiteConfig, InfrastructureConfig)
- [ ] Create AWS CloudFormation resource type definitions (without AWS SDK)
  - [ ] S3 types (Bucket, BucketPolicy, WebsiteConfiguration)
  - [ ] CloudFront types (Distribution, CachePolicy, OriginAccessControl)
  - [ ] Route53 types (HostedZone, RecordSet)
  - [ ] ACM types (Certificate, CertificateValidation)
  - [ ] EC2 types (Instance, SecurityGroup, KeyPair, LaunchTemplate)
  - [ ] ECS types (Cluster, TaskDefinition, Service)
  - [ ] VPC types (VPC, Subnet, RouteTable, InternetGateway, NatGateway)
  - [ ] ALB types (LoadBalancer, TargetGroup, Listener)
  - [ ] IAM types (Role, Policy, User, Group)
  - [ ] EFS types (FileSystem, MountTarget, AccessPoint)
  - [ ] SES types (EmailIdentity, ReceiptRuleSet, ConfigurationSet)
  - [ ] Lambda types (Function, Permission, EventSourceMapping)
  - [ ] EventBridge types (Rule, Target)
  - [ ] WAF types (WebACL, IPSet, RuleGroup)
  - [ ] KMS types (Key, Alias)
  - [ ] Secrets Manager types (Secret, SecretTargetAttachment)
  - [ ] Backup types (BackupVault, BackupPlan, BackupSelection)
  - [ ] Auto Scaling types (AutoScalingGroup, LaunchConfiguration, ScalingPolicy)
  - [ ] Systems Manager types (Parameter, Document)
  - [ ] CloudWatch types (Alarm, LogGroup, Dashboard)
- [ ] Create union types for deployment modes: `server | serverless | hybrid`
- [ ] Define environment types (production, staging, development)

### 1.3 CloudFormation Generator Engine

- [ ] Create CloudFormation template builder class
- [ ] Implement resource naming convention system (slugs, timestamps, environments)
- [ ] Build dependency graph resolver (ensures correct resource ordering)
- [ ] Create intrinsic function helpers (Ref, GetAtt, Sub, Join, etc.)
- [ ] Implement template validation
- [ ] Add support for CloudFormation parameters
- [ ] Add support for CloudFormation outputs
- [ ] Create template serializer (JSON/YAML)
- [ ] Implement stack update diff analyzer

---

## Phase 2: Resource Abstractions (Clean API Design)

### 2.1 Storage Module (S3)

- [ ] Create `Storage` class with clean API
  - [ ] `createBucket(name, options)` - Public/private/encrypted buckets
  - [ ] `enableVersioning(bucket)` - Version control
  - [ ] `enableWebsiteHosting(bucket, indexDoc, errorDoc)` - Static sites
  - [ ] `setLifecycleRules(bucket, rules)` - Auto-cleanup
  - [ ] `enableIntelligentTiering(bucket)` - Cost optimization
  - [ ] `createBackupPlan(buckets, retentionDays)` - AWS Backup integration
- [ ] Generate CloudFormation for S3 bucket configurations
- [ ] Generate bucket policies (public/private access)
- [ ] Generate CORS configurations
- [ ] Generate S3 notifications (Lambda triggers)

### 2.2 CDN Module (CloudFront)

- [ ] Create `CDN` class with clean API
  - [ ] `createDistribution(origin, options)` - CloudFront setup
  - [ ] `setCachePolicy(distribution, ttl)` - Custom cache behavior
  - [ ] `setCustomDomain(distribution, domain, certificate)` - Custom domains
  - [ ] `setErrorPages(distribution, mappings)` - SPA routing (404 → index.html)
  - [ ] `enableHttp3(distribution)` - Modern protocols
  - [ ] `addEdgeFunction(distribution, event, functionArn)` - Lambda@Edge
- [ ] Generate CloudFront distribution CloudFormation
- [ ] Generate Origin Access Control for S3
- [ ] Generate cache policies and behaviors
- [ ] Generate Lambda@Edge associations
- [ ] Support multiple origins (S3, ALB, custom)

### 2.3 DNS Module (Route53)

- [ ] Create `DNS` class with clean API
  - [ ] `createHostedZone(domain)` - DNS zone creation
  - [ ] `lookupHostedZone(domain)` - Existing zone lookup
  - [ ] `createRecord(zone, name, type, value)` - A, AAAA, CNAME, MX, TXT records
  - [ ] `createAlias(zone, name, target)` - Alias to CloudFront/ALB
  - [ ] `createWwwRedirect(domain)` - www → non-www redirect
  - [ ] `createCustomRedirect(from, to)` - Domain redirects
- [ ] Generate Route53 HostedZone CloudFormation
- [ ] Generate RecordSet CloudFormation (all types)
- [ ] Handle DNS validation for ACM certificates
- [ ] Support multi-domain configurations

### 2.4 Security Module (WAF, ACM, KMS)

- [ ] Create `Security` class with clean API
  - [ ] `createCertificate(domain, subdomains)` - SSL/TLS wildcard certs
  - [ ] `createKmsKey(description, rotation)` - Encryption keys
  - [ ] `createFirewall(rules)` - WAF configuration
  - [ ] `blockCountries(countries)` - Geo-blocking
  - [ ] `blockIpAddresses(ips)` - IP blocking
  - [ ] `setRateLimit(requests, window)` - DDoS protection
  - [ ] `addManagedRules(ruleGroups)` - AWS Managed Rules
- [ ] Generate ACM Certificate CloudFormation
- [ ] Generate KMS Key CloudFormation
- [ ] Generate WAF WebACL CloudFormation
- [ ] Generate WAF IPSet and RuleGroup CloudFormation
- [ ] Handle certificate validation wait conditions

### 2.5 Compute Module (EC2 + ECS - Server & Serverless)

- [ ] Create `Compute` class with unified API for both modes

#### Server Mode (EC2 - Forge-style)

- [ ] `createServer(options)` - EC2 instance provisioning
  - [ ] Instance type selection (t3.micro, t3.small, etc.)
  - [ ] AMI selection (Ubuntu, Amazon Linux, etc.)
  - [ ] Key pair management
  - [ ] Security group configuration
  - [ ] User data scripts (setup automation)
  - [ ] Elastic IP allocation
  - [ ] EBS volume configuration
- [ ] `createAutoScalingGroup(options)` - Auto-scaling servers
- [ ] `attachLoadBalancer(servers, alb)` - ALB integration
- [ ] `installSoftware(server, packages)` - Automated software installation
- [ ] Generate EC2 Instance CloudFormation
- [ ] Generate Auto Scaling Group CloudFormation
- [ ] Generate Launch Template CloudFormation
- [ ] Generate user data scripts for common stacks:
  - [ ] Node.js server setup
  - [ ] Bun installation
  - [ ] Nginx/Caddy configuration
  - [ ] SSL certificate automation (Let's Encrypt)
  - [ ] Database clients (PostgreSQL, MySQL)
  - [ ] Redis installation
  - [ ] Process managers (PM2, systemd)

#### Serverless Mode (ECS Fargate - Vapor-style)

- [ ] `createFargateService(options)` - ECS Fargate deployment
  - [ ] Task definition (CPU, memory, container config)
  - [ ] Service configuration (desired count, health checks)
  - [ ] Auto-scaling policies (CPU/memory based)
  - [ ] Docker image configuration
  - [ ] Environment variables
  - [ ] Secrets integration (Secrets Manager)
- [ ] `createLambdaFunction(options)` - Lambda functions
- [ ] Generate ECS Cluster CloudFormation
- [ ] Generate ECS Task Definition CloudFormation
- [ ] Generate ECS Service CloudFormation
- [ ] Generate Application Load Balancer CloudFormation
- [ ] Generate Target Group and Listener CloudFormation
- [ ] Generate Auto Scaling policies CloudFormation
- [ ] Generate Lambda Function CloudFormation

#### Shared Compute Features

- [ ] Health check configuration
- [ ] Container registry integration (ECR)
- [ ] Log aggregation (CloudWatch Logs)
- [ ] Metrics and monitoring
- [ ] Deployment strategies (rolling, blue/green)

### 2.6 Network Module (VPC)

- [ ] Create `Network` class with clean API
  - [ ] `createVpc(cidr, zones)` - VPC with multi-AZ
  - [ ] `createSubnets(vpc, type)` - Public/private/isolated subnets
  - [ ] `createNatGateway(vpc)` - Optional NAT (with cost warning)
  - [ ] `createSecurityGroup(vpc, rules)` - Firewall rules
  - [ ] `enableFlowLogs(vpc)` - VPC traffic logging
- [ ] Generate VPC CloudFormation
- [ ] Generate Subnet CloudFormation (multi-AZ)
- [ ] Generate Internet Gateway CloudFormation
- [ ] Generate NAT Gateway CloudFormation (optional)
- [ ] Generate Route Table CloudFormation
- [ ] Generate Security Group CloudFormation
- [ ] Smart subnet allocation (CIDR calculator)

### 2.7 File System Module (EFS)

- [ ] Create `FileSystem` class with clean API
  - [ ] `createFileSystem(options)` - EFS creation
  - [ ] `createMountTarget(fs, subnet)` - Multi-AZ mount targets
  - [ ] `createAccessPoint(fs, path, permissions)` - POSIX permissions
  - [ ] `setLifecyclePolicy(fs, daysToIA)` - Cost optimization
  - [ ] `enableBackup(fs)` - Automatic backups
- [ ] Generate EFS FileSystem CloudFormation
- [ ] Generate EFS MountTarget CloudFormation
- [ ] Generate EFS AccessPoint CloudFormation
- [ ] Generate backup configurations

### 2.8 Email Module (SES)

- [ ] Create `Email` class with clean API
  - [ ] `verifyDomain(domain)` - Domain verification
  - [ ] `configureDkim(domain)` - DKIM signing
  - [ ] `setSpfRecord(domain)` - SPF configuration
  - [ ] `setDmarcRecord(domain, policy)` - DMARC policy
  - [ ] `createReceiptRule(domain, s3Bucket, lambda)` - Inbound email
  - [ ] `createEmailTemplate(name, template)` - Templated emails
- [ ] Generate SES EmailIdentity CloudFormation
- [ ] Generate SES ReceiptRuleSet CloudFormation
- [ ] Generate SES ConfigurationSet CloudFormation
- [ ] Generate DNS records for DKIM/SPF/DMARC
- [ ] Generate Lambda functions for email processing
- [ ] Generate S3 bucket policies for SES writes

### 2.9 Queue & Scheduling Module (EventBridge + SQS)

- [ ] Create `Queue` class with clean API
  - [ ] `createSchedule(name, cron, target)` - Cron jobs
  - [ ] `createQueue(name, options)` - SQS queues
  - [ ] `createDeadLetterQueue(queue, maxReceives)` - DLQ setup
  - [ ] `scheduleEcsTask(cron, taskDefinition, overrides)` - ECS scheduled tasks
  - [ ] `scheduleLambda(cron, functionArn)` - Lambda scheduled execution
- [ ] Generate EventBridge Rule CloudFormation
- [ ] Generate EventBridge Target CloudFormation
- [ ] Generate SQS Queue CloudFormation
- [ ] Generate ECS task overrides for jobs
- [ ] Support dynamic job discovery from project files

### 2.10 AI Module (Bedrock)

- [ ] Create `AI` class with clean API
  - [ ] `enableBedrock(models)` - IAM permissions for Bedrock
  - [ ] `createBedrockRole(service)` - Service-specific roles
- [ ] Generate IAM roles for Bedrock access
- [ ] Generate policies for model invocation
- [ ] Support streaming and standard invocation

### 2.11 Database Module (RDS + DynamoDB)

- [ ] Create `Database` class with clean API

#### Relational (RDS - for Server mode)

- [ ] `createPostgres(options)` - PostgreSQL database
- [ ] `createMysql(options)` - MySQL database
- [ ] `createReadReplica(primary, regions)` - Read replicas
- [ ] `enableBackup(db, retentionDays)` - Automated backups
- [ ] Generate RDS DBInstance CloudFormation
- [ ] Generate RDS DBSubnetGroup CloudFormation
- [ ] Generate RDS security group rules
- [ ] Generate RDS parameter groups

#### NoSQL (DynamoDB - for Serverless mode)

- [ ] `createTable(name, keys, options)` - DynamoDB tables
- [ ] `enableStreams(table)` - Change data capture
- [ ] `createGlobalTable(table, regions)` - Multi-region
- [ ] Generate DynamoDB Table CloudFormation
- [ ] Generate DynamoDB auto-scaling CloudFormation

### 2.12 Cache Module (ElastiCache)

- [ ] Create `Cache` class with clean API
  - [ ] `createRedis(options)` - Redis cluster
  - [ ] `createMemcached(options)` - Memcached cluster
  - [ ] `enableClusterMode(cache)` - Redis cluster mode
- [ ] Generate ElastiCache Cluster CloudFormation
- [ ] Generate ElastiCache SubnetGroup CloudFormation
- [ ] Generate security group rules

### 2.13 Permissions Module (IAM)

- [ ] Create `Permissions` class with clean API
  - [ ] `createUser(name, groups)` - IAM users
  - [ ] `createRole(name, policies)` - IAM roles
  - [ ] `createPolicy(name, statements)` - Custom policies
  - [ ] `attachPolicy(entity, policy)` - Policy attachment
  - [ ] `createAccessKey(user)` - Programmatic access
  - [ ] `setPasswordPolicy(requirements)` - Password rules
- [ ] Generate IAM User CloudFormation
- [ ] Generate IAM Role CloudFormation
- [ ] Generate IAM Policy CloudFormation
- [ ] Generate managed policy attachments

### 2.14 Deployment Module

- [ ] Create `Deployment` class with clean API
  - [ ] `deployToS3(source, bucket, prefix)` - Asset deployment
  - [ ] `invalidateCache(distribution, paths)` - CloudFront invalidation
  - [ ] `deployContainer(image, service)` - ECS deployment
  - [ ] `deployLambda(zip, function)` - Lambda deployment
  - [ ] `deployServer(files, server, strategy)` - EC2 deployment (rsync, git pull, etc.)
- [ ] Implement asset hashing for change detection
- [ ] Create deployment strategies (incremental, full)
- [ ] Generate CodeDeploy configurations for EC2
- [ ] Generate ECS deployment configurations

### 2.15 Monitoring Module (CloudWatch)

- [ ] Create `Monitoring` class with clean API
  - [ ] `createAlarm(metric, threshold, actions)` - CloudWatch alarms
  - [ ] `createDashboard(widgets)` - Monitoring dashboards
  - [ ] `createLogGroup(name, retention)` - Log management
  - [ ] `setMetricFilter(logGroup, pattern, metric)` - Custom metrics
- [ ] Generate CloudWatch Alarm CloudFormation
- [ ] Generate CloudWatch Dashboard CloudFormation
- [ ] Generate CloudWatch LogGroup CloudFormation

---

## Phase 3: CLI Development

### 3.1 Core CLI Infrastructure

- [ ] Set up CLI framework (use Bun native or lightweight CLI library)
- [ ] Create command parser and router
- [ ] Implement global flags (--env, --region, --profile, --verbose, --dry-run)
- [ ] Add colored terminal output
- [ ] Create progress indicators and spinners
- [ ] Implement error handling and user-friendly messages
- [ ] Add interactive prompts for missing configuration

### 3.2 Initialization Commands

- [ ] `cloud init` - Initialize new project
  - [ ] Create `cloud.config.ts` with TypeScript types
  - [ ] Interactive prompts for:
    - [ ] Deployment mode (server, serverless, or hybrid)
    - [ ] Project name and slug
    - [ ] AWS region selection
    - [ ] Domain configuration
    - [ ] Environment setup (production, staging, dev)
  - [ ] Generate `.env.example` template
  - [ ] Create `.gitignore` for cloud resources
- [ ] `cloud init:server` - Initialize server-based (EC2) project
- [ ] `cloud init:serverless` - Initialize serverless (Fargate/Lambda) project
- [ ] `cloud init:hybrid` - Initialize hybrid project (both modes)

### 3.3 Configuration Commands

- [ ] `cloud config` - Show current configuration
- [ ] `cloud config:validate` - Validate configuration file
- [ ] `cloud config:env` - Manage environment variables
- [ ] `cloud config:secrets` - Manage secrets (AWS Secrets Manager)

### 3.4 Generation Commands

- [ ] `cloud generate` - Generate CloudFormation templates
  - [ ] Output to `./cloudformation` directory
  - [ ] Separate templates per module (storage, compute, network, etc.)
  - [ ] Master template with nested stacks
  - [ ] Support JSON and YAML output formats
- [ ] `cloud generate:preview` - Preview what will be generated
- [ ] `cloud generate:diff` - Show diff from existing stack

### 3.5 Deployment Commands (Server Mode)

- [ ] `cloud deploy:server` - Deploy EC2 infrastructure
  - [ ] Create/update CloudFormation stack
  - [ ] Provision EC2 instances
  - [ ] Configure security groups
  - [ ] Set up load balancers
  - [ ] Install software via user data
- [ ] `cloud server:create NAME` - Create new server
- [ ] `cloud server:list` - List all servers
- [ ] `cloud server:ssh NAME` - SSH into server
- [ ] `cloud server:resize NAME TYPE` - Change instance type
- [ ] `cloud server:reboot NAME` - Reboot server
- [ ] `cloud server:destroy NAME` - Terminate server
- [ ] `cloud server:logs NAME` - View server logs
- [ ] `cloud server:deploy NAME` - Deploy app to server
  - [ ] Support multiple strategies: git, rsync, scp
  - [ ] Zero-downtime deployments
  - [ ] Rollback capability

### 3.6 Deployment Commands (Serverless Mode)

- [ ] `cloud deploy:serverless` - Deploy serverless infrastructure
  - [ ] Create/update CloudFormation stack
  - [ ] Build and push Docker images to ECR
  - [ ] Update ECS task definitions
  - [ ] Deploy Lambda functions
- [ ] `cloud function:create NAME` - Create new Lambda function
- [ ] `cloud function:list` - List all functions
- [ ] `cloud function:logs NAME` - View function logs
- [ ] `cloud function:invoke NAME` - Test function invocation
- [ ] `cloud function:deploy NAME` - Deploy specific function
- [ ] `cloud container:build` - Build Docker image
- [ ] `cloud container:push` - Push to ECR
- [ ] `cloud container:deploy` - Update ECS service

### 3.7 Universal Deployment Commands

- [ ] `cloud deploy` - Smart deploy (detects mode from config)
  - [ ] Auto-detect changes since last deployment
  - [ ] Show deployment plan before execution
  - [ ] Confirm before proceeding
  - [ ] Real-time progress updates
  - [ ] Rollback on failure
- [ ] `cloud deploy:assets` - Deploy static assets to S3
- [ ] `cloud deploy:rollback` - Rollback to previous version
- [ ] `cloud deploy:status` - Check deployment status

### 3.8 Domain & DNS Commands

- [ ] `cloud domain:add DOMAIN` - Add new domain
- [ ] `cloud domain:list` - List all domains
- [ ] `cloud domain:verify DOMAIN` - Verify domain ownership
- [ ] `cloud domain:ssl DOMAIN` - Generate SSL certificate
- [ ] `cloud dns:records DOMAIN` - List DNS records
- [ ] `cloud dns:add DOMAIN TYPE VALUE` - Add DNS record

### 3.9 Database Commands

- [ ] `cloud db:create NAME TYPE` - Create database (RDS or DynamoDB)
- [ ] `cloud db:list` - List all databases
- [ ] `cloud db:backup NAME` - Create database backup
- [ ] `cloud db:restore NAME BACKUP_ID` - Restore from backup
- [ ] `cloud db:connect NAME` - Get connection details
- [ ] `cloud db:tunnel NAME` - Create SSH tunnel to database

### 3.10 Cache Commands

- [ ] `cloud cache:create NAME` - Create cache cluster
- [ ] `cloud cache:flush NAME` - Flush cache
- [ ] `cloud cache:stats NAME` - View cache statistics

### 3.11 Queue & Job Commands

- [ ] `cloud queue:create NAME` - Create SQS queue
- [ ] `cloud queue:list` - List all queues
- [ ] `cloud schedule:add NAME CRON TASK` - Add scheduled job
- [ ] `cloud schedule:list` - List all schedules
- [ ] `cloud schedule:remove NAME` - Remove schedule

### 3.12 Monitoring & Logs Commands

- [ ] `cloud logs` - Stream all application logs
- [ ] `cloud logs:server NAME` - Server-specific logs
- [ ] `cloud logs:function NAME` - Function-specific logs
- [ ] `cloud logs:tail` - Tail logs in real-time
- [ ] `cloud metrics` - View key metrics
- [ ] `cloud metrics:dashboard` - Open CloudWatch dashboard
- [ ] `cloud alarms` - List all alarms
- [ ] `cloud alarms:create` - Create new alarm

### 3.13 Security Commands

- [ ] `cloud firewall:rules` - List WAF rules
- [ ] `cloud firewall:block IP` - Block IP address
- [ ] `cloud firewall:unblock IP` - Unblock IP address
- [ ] `cloud firewall:countries` - Manage geo-blocking
- [ ] `cloud ssl:list` - List all certificates
- [ ] `cloud ssl:renew DOMAIN` - Renew certificate
- [ ] `cloud secrets:set KEY VALUE` - Set secret
- [ ] `cloud secrets:get KEY` - Get secret value
- [ ] `cloud secrets:list` - List all secrets

### 3.14 Cost & Resource Management

- [ ] `cloud cost` - Show estimated monthly cost
- [ ] `cloud cost:breakdown` - Cost breakdown by service
- [ ] `cloud resources` - List all resources
- [ ] `cloud resources:unused` - Find unused resources
- [ ] `cloud optimize` - Suggest cost optimizations

### 3.15 Stack Management Commands

- [ ] `cloud stack:list` - List all CloudFormation stacks
- [ ] `cloud stack:events STACK` - Show stack events
- [ ] `cloud stack:outputs STACK` - Show stack outputs
- [ ] `cloud stack:delete STACK` - Delete stack
- [ ] `cloud stack:export STACK` - Export stack template

### 3.16 Team & Collaboration Commands

- [ ] `cloud team:add EMAIL ROLE` - Add team member
- [ ] `cloud team:list` - List team members
- [ ] `cloud team:remove EMAIL` - Remove team member
- [ ] `cloud env:create NAME` - Create new environment (staging, dev)
- [ ] `cloud env:list` - List environments
- [ ] `cloud env:switch NAME` - Switch active environment

### 3.17 Utility Commands

- [ ] `cloud doctor` - Check AWS credentials and configuration
- [ ] `cloud regions` - List available AWS regions
- [ ] `cloud version` - Show CLI version
- [ ] `cloud upgrade` - Upgrade CLI to latest version
- [ ] `cloud help` - Show help documentation

---

## Phase 4: Configuration System

### 4.1 Configuration File Design

- [ ] Create TypeScript-based configuration (`cloud.config.ts`)
- [ ] Support multiple environments in single config
- [ ] Environment variable interpolation
- [ ] Configuration validation with Zod or similar
- [ ] Configuration inheritance (base + environment overrides)
- [ ] Secrets reference system (avoid storing in config)

### 4.2 Configuration Schema

- [ ] Define top-level schema:

  ```typescript
  {
    project: { name, slug, region }
    mode: 'server' | 'serverless' | 'hybrid'
    environments: { production, staging, development }
    infrastructure: { ... }
    sites: { ... }
  }
  ```

- [ ] Define infrastructure schema for server mode:
  - [ ] EC2 instance types, AMIs, key pairs
  - [ ] Auto-scaling configuration
  - [ ] Load balancer settings
  - [ ] Software installation scripts
- [ ] Define infrastructure schema for serverless mode:
  - [ ] ECS task resources (CPU, memory)
  - [ ] Lambda function configuration
  - [ ] Container registry settings
- [ ] Define shared infrastructure schema:
  - [ ] VPC and networking
  - [ ] Database configuration
  - [ ] Cache settings
  - [ ] Storage buckets
  - [ ] CDN configuration
  - [ ] DNS and domains
  - [ ] Security (WAF, certificates)
  - [ ] Monitoring and alerting

### 4.3 Configuration Presets

- [ ] Create preset for "Static Site" (S3 + CloudFront)
- [ ] Create preset for "Node.js Server" (EC2 + ALB)
- [ ] Create preset for "Node.js Serverless" (Fargate + ALB)
- [ ] Create preset for "Full Stack App" (Frontend + API + Database)
- [ ] Create preset for "Microservices" (Multiple services + API Gateway)
- [ ] Allow users to extend presets

---

## Phase 5: AWS Driver Implementation

### 5.1 CloudFormation Template Generation

- [ ] Implement template builder for each resource type
- [ ] Handle CloudFormation intrinsic functions properly
- [ ] Generate correct DependsOn relationships
- [ ] Handle circular dependency resolution
- [ ] Support CloudFormation conditions
- [ ] Support CloudFormation mappings
- [ ] Generate proper IAM policies (least privilege)

### 5.2 CloudFormation Deployment (Using AWS CLI)

- [ ] Use Bun to shell out to AWS CLI (no SDK dependency)
- [ ] `aws cloudformation create-stack` wrapper
- [ ] `aws cloudformation update-stack` wrapper
- [ ] `aws cloudformation delete-stack` wrapper
- [ ] `aws cloudformation describe-stacks` wrapper
- [ ] Change set creation and review
- [ ] Stack event streaming during deployment
- [ ] Wait for stack completion with proper error handling
- [ ] Handle stack rollback scenarios

### 5.3 AWS CLI Helpers

- [ ] Detect and validate AWS CLI installation
- [ ] Guide users to install AWS CLI if missing
- [ ] Use AWS CLI profiles for multi-account support
- [ ] Use AWS CLI for S3 uploads (`aws s3 sync`)
- [ ] Use AWS CLI for CloudFront invalidations
- [ ] Use AWS CLI for ECR login and image push
- [ ] Use AWS CLI for SSM Session Manager (server SSH alternative)
- [ ] Parse AWS CLI JSON output for structured data

### 5.4 AWS Type Definitions (No SDK)

- [ ] Create lightweight type definitions matching CloudFormation specs
- [ ] Reference official AWS CloudFormation Resource Specification
- [ ] Generate types from CloudFormation resource schemas
- [ ] Keep types updated with AWS releases
- [ ] Export types for user consumption

### 5.5 AWS-Specific Features

- [ ] Handle AWS account ID retrieval
- [ ] Handle AWS region detection
- [ ] Manage CloudFormation stack parameters
- [ ] Store and retrieve stack metadata (SSM Parameter Store)
- [ ] Handle Lambda@Edge deletion delays gracefully
- [ ] Implement S3 bucket cleanup before deletion
- [ ] Handle certificate validation delays

---

## Phase 6: Developer Experience

### 6.1 Documentation

- [ ] Write comprehensive README
- [ ] Create getting started guide
- [ ] Write configuration reference
- [ ] Create CLI command reference
- [ ] Write CloudFormation template guide
- [ ] Create example projects for each preset
- [ ] Write migration guides (from CDK, Terraform, etc.)
- [ ] Create troubleshooting guide
- [ ] Write best practices guide
- [ ] Document server vs serverless trade-offs

### 6.2 Error Handling & Debugging

- [ ] Implement verbose mode for debugging
- [ ] Clear error messages with solutions
- [ ] Validate AWS credentials before deployment
- [ ] Check AWS service quotas
- [ ] Detect common misconfigurations
- [ ] Suggest fixes for common errors
- [ ] Create error code reference
- [ ] Log full stack traces in debug mode

### 6.3 Testing Infrastructure

- [ ] Unit tests for CloudFormation generation
- [ ] Integration tests for CLI commands
- [ ] Mock AWS CLI responses for testing
- [ ] Test template validation
- [ ] Test configuration validation
- [ ] Test dependency graph resolution
- [ ] Create test fixtures for common scenarios

### 6.4 Performance Optimization

- [ ] Parallelize CloudFormation stack creation where possible
- [ ] Cache CloudFormation templates for comparison
- [ ] Optimize file hashing for deployments
- [ ] Implement incremental deployments (only changed resources)
- [ ] Use Bun's native performance features
- [ ] Optimize CLI startup time
- [ ] Minimize memory footprint

### 6.5 IDE Integration

- [ ] TypeScript types for autocomplete in config files
- [ ] JSON schema for `cloud.config.json`
- [ ] VSCode extension (future consideration)
- [ ] Syntax highlighting for CloudFormation output

---

## Phase 7: Advanced Features

### 7.1 Multi-Region Support

- [ ] Deploy stacks to multiple regions
- [ ] Configure global resources (Route53, CloudFront)
- [ ] Handle cross-region references
- [ ] Global database replication
- [ ] Multi-region failover strategies

### 7.2 Multi-Account Support

- [ ] Support AWS Organizations
- [ ] Cross-account IAM roles
- [ ] Separate environments in different accounts
- [ ] Consolidated billing integration

### 7.3 CI/CD Integration

- [ ] Generate GitHub Actions workflows
- [ ] Generate GitLab CI configurations
- [ ] Generate CircleCI configurations
- [ ] Pre-commit hooks for validation
- [ ] Automated rollback on failures

### 7.4 Backup & Disaster Recovery

- [ ] Automated backup schedules
- [ ] Point-in-time recovery
- [ ] Cross-region backup replication
- [ ] Disaster recovery runbooks
- [ ] Automated failover testing

### 7.5 Compliance & Governance

- [ ] AWS Config rules generation
- [ ] CloudTrail configuration
- [ ] GuardDuty setup
- [ ] Security Hub integration
- [ ] Compliance report generation

### 7.6 Advanced Deployment Strategies

- [ ] Blue/green deployments for servers
- [ ] Canary deployments for serverless
- [ ] A/B testing infrastructure
- [ ] Feature flags integration
- [ ] Traffic splitting

### 7.7 Observability

- [ ] Distributed tracing (X-Ray)
- [ ] Custom metrics collection
- [ ] Log aggregation across services
- [ ] APM integration
- [ ] Synthetic monitoring

---

## Phase 8: Future Drivers

### 8.1 Azure Driver (Future)

- [ ] Research Azure Resource Manager templates
- [ ] Design Azure-specific abstractions
- [ ] Map AWS resources to Azure equivalents:
  - [ ] S3 → Azure Blob Storage
  - [ ] CloudFront → Azure CDN
  - [ ] Route53 → Azure DNS
  - [ ] EC2 → Azure VMs
  - [ ] ECS → Azure Container Instances
  - [ ] Lambda → Azure Functions
  - [ ] RDS → Azure Database
- [ ] Implement Azure CLI integration
- [ ] Create Azure type definitions

### 8.2 GCP Driver (Future)

- [ ] Research GCP Deployment Manager
- [ ] Design GCP-specific abstractions
- [ ] Map AWS resources to GCP equivalents
- [ ] Implement gcloud CLI integration

### 8.3 Multi-Cloud Abstraction

- [ ] Create provider-agnostic API
- [ ] Implement provider detection and switching
- [ ] Handle provider-specific features gracefully
- [ ] Multi-cloud deployment orchestration

---

## Phase 9: Launch Preparation

### 9.1 Beta Testing

- [ ] Create private beta program
- [ ] Gather feedback from early users
- [ ] Fix critical bugs
- [ ] Improve UX based on feedback
- [ ] Create feedback collection system

### 9.2 Performance Benchmarking

- [ ] Benchmark against AWS CDK
- [ ] Benchmark against Terraform
- [ ] Measure deployment times
- [ ] Measure CLI startup performance
- [ ] Create performance regression tests

### 9.3 Security Audit

- [ ] Review IAM policies for least privilege
- [ ] Audit secret handling
- [ ] Review CloudFormation templates for security issues
- [ ] Check for dependency vulnerabilities
- [ ] Create security documentation

### 9.4 Release Engineering

- [ ] Set up automated releases
- [ ] Create release notes template
- [ ] Version bump automation
- [ ] Changelog generation
- [ ] npm/Bun package publishing
- [ ] Homebrew formula (for CLI)
- [ ] Docker image (for CI/CD)

### 9.5 Marketing & Community

- [ ] Create project website
- [ ] Write launch blog post
- [ ] Create demo videos
- [ ] Set up Discord/Slack community
- [ ] Submit to package registries
- [ ] Create Twitter/social media presence
- [ ] Reach out to developer communities

---

## Success Metrics

- [ ] **Performance**: Deploy infrastructure in < 5 minutes
- [ ] **Size**: Keep package size under 5MB (vs CDK ~100MB+)
- [ ] **Type Safety**: 100% TypeScript coverage with strict mode
- [ ] **Zero Dependencies**: Core library has 0 runtime dependencies (only AWS CLI)
- [ ] **Documentation**: Every feature documented with examples
- [ ] **Test Coverage**: > 80% code coverage
- [ ] **User Satisfaction**: NPS score > 50 in first 6 months

---

## Nice-to-Have Features (Post-Launch)

- [ ] Visual infrastructure designer (web UI)
- [ ] Cost estimation before deployment
- [ ] Infrastructure drift detection
- [ ] Automated security scanning
- [ ] Infrastructure as Code diff tool (visual)
- [ ] One-click infrastructure cloning
- [ ] Infrastructure templates marketplace
- [ ] Terraform migration tool
- [ ] CDK migration tool
- [ ] Infrastructure documentation generator
- [ ] Real-time collaboration on configs
- [ ] Infrastructure version control
- [ ] Policy as code enforcement
- [ ] Custom resource providers
- [ ] Plugin system for extending functionality
