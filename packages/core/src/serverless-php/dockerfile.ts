/**
 * Generates the Dockerfile that builds the ts-cloud PHP runtime layer for AWS
 * Lambda (`provided.al2023`). Built on AlmaLinux 9 — it shares glibc 2.34 with
 * the Lambda runtime, and (unlike Amazon Linux 2023) the Remi repository's
 * release RPM installs there, giving version-isolated PHP SCL packages
 * (`php83-php-*` under `/opt/remi/php83/`) so the same recipe builds PHP 8.1–8.4.
 *
 * The PHP binary, php-fpm, extensions, and all their non-glibc shared-library
 * dependencies are relocated + bundled under `/opt` so the archive runs as a
 * provided.al2023 Lambda layer.
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
  'curl', // required by the runtime loop (Lambda Runtime API) + Laravel HTTP client
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
  return PHP_LAYER_EXTENSIONS.map((ext) => `${scl}-php-${ext}`)
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
  // Remi SCL keeps php config under /etc/opt/remi/<scl>/, not <sclRoot>/etc.
  const sclEtc = `/etc/opt/remi/${scl}`
  const from = asName ? `FROM almalinux:9 AS ${asName}` : 'FROM almalinux:9'

  return `${from}

# Build PHP on AlmaLinux 9 (where Remi's version-isolated SCL packages install
# cleanly — Remi's release RPM rejects Amazon Linux 2023). AlmaLinux 9 shares
# glibc 2.34 with the provided.al2023 Lambda runtime, and the relocation step
# below bundles every non-glibc shared lib under /opt/php/lib, so the resulting
# /opt tree runs on Lambda's provided.al2023.
RUN dnf -y install epel-release dnf-plugins-core 'dnf-command(config-manager)' && \\
    dnf config-manager --set-enabled crb && \\
    dnf -y install https://rpms.remirepo.net/enterprise/remi-release-9.rpm && \\
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
    cp -a ${sclEtc}/php.d/*.ini /opt/php/etc/php.d/ 2>/dev/null || true; \\
    # Rewrite any absolute extension/zend_extension paths to bare names so they
    # resolve against the relocated extension_dir.
    sed -i -E "s#(zend_)?extension *= *.*/([^/]+\\.so)#\\1extension=\\2#" /opt/php/etc/php.d/*.ini 2>/dev/null || true; \\
    # Copy shared-library dependencies of php, php-fpm, and the extension modules.
    for bin in /opt/php/bin/php /opt/php/sbin/php-fpm /opt/php/lib/php/modules/*.so; do \\
      ldd "$bin" 2>/dev/null | awk '/=>/{print $3}/ld-linux/{print $1}' | sort -u | while read -r lib; do \\
        [ -f "$lib" ] && cp -Ln "$lib" /opt/php/lib/ || true; \\
      done; \\
    done

# Build the relocated main php.ini: extension_dir + every per-extension directive.
RUN printf 'extension_dir=/opt/php/lib/php/modules\\n' > /opt/php/etc/php.ini && \\
    cat /opt/php/etc/php.d/*.ini >> /opt/php/etc/php.ini 2>/dev/null || true

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
