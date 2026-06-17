<?php

namespace TsCloud\Serverless\Console;

use Illuminate\Console\Command;
use Throwable;
use TsCloud\Serverless\Queue\LambdaSqsJob;

/**
 * Processes exactly one SQS message that the Lambda queue runtime has delivered.
 *
 * The runtime sets the raw message body in the TSCLOUD_SQS_RECORD environment
 * variable and invokes this command once per record. The job is fired in-process
 * (no SQS polling); a thrown exception → non-zero exit → the runtime reports a
 * batch-item failure → Lambda retries / DLQs the message. Success deletes it.
 */
class SqsHandleCommand extends Command
{
    protected $signature = 'tscloud:sqs-handle {--record= : Raw SQS message body (defaults to TSCLOUD_SQS_RECORD)}';

    protected $description = 'Process a single SQS message delivered by the ts-cloud Lambda queue runtime';

    public function handle(): int
    {
        $raw = $this->option('record');
        if ($raw === null || $raw === '') {
            $env = getenv('TSCLOUD_SQS_RECORD');
            $raw = $env === false ? '' : $env;
        }

        if ($raw === '') {
            $this->error('No SQS record provided (TSCLOUD_SQS_RECORD is empty).');
            return self::FAILURE;
        }

        $connection = (string) (config('queue.default') ?: 'sqs');
        $queue = (string) (config("queue.connections.{$connection}.queue") ?: (getenv('TSCLOUD_QUEUE') ?: 'default'));
        $receiveCount = (int) (getenv('TSCLOUD_SQS_RECEIVE_COUNT') ?: 1);

        $job = new LambdaSqsJob($this->laravel, $raw, $connection, $queue, $receiveCount);

        try {
            // Job::fire() decodes the payload and dispatches the handler once.
            $job->fire();
        } catch (Throwable $e) {
            report($e);
            $this->error('Job failed: ' . $e->getMessage());
            return self::FAILURE;
        }

        return self::SUCCESS;
    }
}
