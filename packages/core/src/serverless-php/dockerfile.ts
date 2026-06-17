/**
 * Generates the Dockerfile that builds the ts-cloud PHP runtime layer for AWS
 * Lambda (`provided.al2023`). Built against Amazon Linux 2023 so glibc and the
 * shared libraries match the Lambda execution environment.
 *
 * AL2023's default repos can't select an arbitrary PHP minor version, so we use
 * the Remi repository's SCL-style packages (`php83-php-*`, installed under
 * `/opt/remi/php83/`), which lets the same recipe build PHP 8.1–8.4. The PHP
 * binary, php-fpm, extensions, and their shared-library dependencies are then
 * relocated under `/opt` so the archive works as a Lambda layer.
 *
 * Build it in CI (Docker required) — see {@link buildPhpRuntimeLayerZip}. The
 * resulting /opt tree is published as a Lambda layer.
 */

/**
 * Laravel + serverless extension suffixes (appended to the `php{XY}-php-` Remi
 * SCL prefix). `process` provides pcntl/posix; `pecl-redis6` the redis driver.
 */
export const PHP_LAYER_EXTENSIONS: string[] = [
  'cli',
  'fpm',
  'mbstring',
  'xml',
  'pdo',
  'mysqlnd',
  'gd',
  'bcmath',
  'intl',
  'opcache',
  'sodium',
  'process',
  'pecl-redis6',
  'pecl-apcu',
  'pgsql',
]

/** Full Remi SCL package names for a given PHP version (e.g. '8.3' → php83-php-*). */
export function phpLayerPackages(phpVersion: string): string[] {
  const scl = `php${phpVersion.replace('.', '')}`
  return PHP_LAYER_EXTENSIONS.map(ext => `${scl}-php-${ext}`)
}

export interface PhpDockerfileOptions {
  /** PHP version: 8.1 | 8.2 | 8.3 | 8.4. @default '8.3' */
  phpVersion?: string
}

/**
 * The `FROM amazonlinux:2023 … /opt` build stage that compiles + relocates PHP.
 * Shared by the standalone layer build and the multi-stage app-image build.
 * Pass `asName` to emit `FROM amazonlinux:2023 AS <name>` for multi-stage use.
 */
export function phpLayerBuildStage(phpVersion: string, asName?: string): string {
  const scl = `php${phpVersion.replace('.', '')}`
  const packages = phpLayerPackages(phpVersion).join(' \\\n      ')
  const sclRoot = `/opt/remi/${scl}/root`
  const from = asName ? `FROM amazonlinux:2023 AS ${asName}` : 'FROM amazonlinux:2023'

  return `${from}

# Remi provides version-isolated PHP SCL packages for EL9 (AL2023 compatible).
RUN dnf -y install dnf-plugins-core 'dnf-command(config-manager)' && \\
    dnf -y install https://rpms.remirepo.net/enterprise/remi-release-9.rpm && \\
    dnf -y update && \\
    dnf -y install \\
      ${packages} \\
      findutils tar gzip && \\
    dnf clean all

# Relocate PHP + php-fpm + extensions and their shared libs under /opt.
RUN set -eux; \\
    mkdir -p /opt/php/bin /opt/php/sbin /opt/php/lib /opt/php/lib/php/modules /opt/php/etc/php.d /opt/tscloud; \\
    cp ${sclRoot}/usr/bin/php /opt/php/bin/php; \\
    cp ${sclRoot}/usr/sbin/php-fpm /opt/php/sbin/php-fpm; \\
    EXT_DIR="$(${sclRoot}/usr/bin/php -r 'echo ini_get("extension_dir");')"; \\
    cp -a "$EXT_DIR"/*.so /opt/php/lib/php/modules/ || true; \\
    cp -a ${sclRoot}/etc/php.d/*.ini /opt/php/etc/php.d/ 2>/dev/null || true; \\
    # Copy shared-library dependencies of php, php-fpm, and the extension modules.
    for bin in /opt/php/bin/php /opt/php/sbin/php-fpm /opt/php/lib/php/modules/*.so; do \\
      ldd "$bin" 2>/dev/null | awk '/=>/{print $3}/ld-linux/{print $1}' | sort -u | while read -r lib; do \\
        [ -f "$lib" ] && cp -Ln "$lib" /opt/php/lib/ || true; \\
      done; \\
    done

# Point PHP at the relocated config + extension dir.
RUN printf 'extension_dir=/opt/php/lib/php/modules\\n' > /opt/php/etc/php.ini && \\
    cat /opt/php/etc/php.d/*.ini >> /opt/php/etc/php.ini 2>/dev/null || true
ENV PHP_INI_SCAN_DIR=/opt/php/etc/php.d

# Runtime assets (bootstrap, runtime loops, fpm config) are added by the build
# orchestrator after the image is produced. Export /opt as the layer payload.
CMD ["true"]
`
}

/**
 * Standalone Dockerfile that builds the PHP runtime layer payload at /opt.
 * Used by {@link buildPhpRuntimeLayerZip}.
 */
export function generatePhpLayerDockerfile(options: PhpDockerfileOptions = {}): string {
  const phpVersion = options.phpVersion ?? '8.3'
  return `# ts-cloud PHP ${phpVersion} runtime layer (generated) — AWS Lambda provided.al2023.
${phpLayerBuildStage(phpVersion)}`
}
