<?php

namespace TsCloud\Serverless\Console;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * Runs a single SQL statement against the app's database from inside the Lambda
 * (which is in the VPC and can reach a private Aurora cluster), printing the
 * result as JSON. Backs `cloud serverless:db-shell`, giving ad-hoc query access
 * to a private serverless database without a bastion/jumpbox.
 *
 * The SQL is passed base64-encoded so it survives the runtime's whitespace-based
 * argument parsing.
 */
class DbQueryCommand extends Command
{
    protected $signature = 'tscloud:db-query {--sql=} {--sql-base64=} {--connection=}';

    protected $description = 'Run a SQL statement against the database and print JSON (ts-cloud serverless db shell)';

    public function handle(): int
    {
        $sql = (string) $this->option('sql');
        if ($sql === '' && $this->option('sql-base64')) {
            $sql = (string) base64_decode((string) $this->option('sql-base64'), true);
        }
        $sql = trim($sql);
        if ($sql === '') {
            $this->line(json_encode(['error' => 'no SQL provided']));
            return self::FAILURE;
        }

        $connection = $this->option('connection') ? DB::connection($this->option('connection')) : DB::connection();

        try {
            // Reads return rows; everything else returns the affected-row count.
            if (preg_match('/^\s*(select|show|describe|desc|explain|pragma|with)\b/i', $sql)) {
                $rows = $connection->select($sql);
                $this->line(json_encode(['rows' => $rows], JSON_UNESCAPED_SLASHES));
            } else {
                $affected = $connection->affectingStatement($sql);
                $this->line(json_encode(['affected' => $affected]));
            }
        } catch (Throwable $e) {
            $this->line(json_encode(['error' => $e->getMessage()]));
            return self::FAILURE;
        }

        return self::SUCCESS;
    }
}
