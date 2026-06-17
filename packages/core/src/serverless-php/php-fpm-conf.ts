/**
 * Generates the php-fpm.conf used by the ts-cloud PHP Lambda runtime.
 *
 * A Lambda container serves exactly one request at a time, so FPM is configured
 * with a single static worker listening on a unix socket in /tmp (the only
 * writable location). Output goes to stderr → CloudWatch.
 */

export interface PhpFpmConfigOptions {
  /** Unix socket path FPM listens on. @default '/tmp/.tscloud-fpm.sock' */
  socketPath?: string
  /** Workers per container. Lambda is single-request, so 1 is correct. @default 1 */
  maxChildren?: number
  /** php-fpm error log path. @default '/tmp/storage/logs/php-fpm.log' */
  errorLog?: string
}

export function generatePhpFpmConfig(options: PhpFpmConfigOptions = {}): string {
  const socket = options.socketPath ?? '/tmp/.tscloud-fpm.sock'
  const maxChildren = options.maxChildren ?? 1
  const errorLog = options.errorLog ?? '/tmp/storage/logs/php-fpm.log'

  return `; ts-cloud php-fpm configuration (generated) — AWS Lambda custom runtime.
[global]
daemonize = no
error_log = ${errorLog}
log_level = warning

[www]
listen = ${socket}
listen.mode = 0666
pm = static
pm.max_children = ${maxChildren}
catch_workers_output = yes
decorate_workers_output = no
; Surface fatal errors / fpm logs to the Lambda log stream.
php_admin_value[error_log] = /dev/stderr
php_admin_flag[log_errors] = on
clear_env = no
`
}
