<?php

namespace TsCloud\Serverless;

use Illuminate\Support\ServiceProvider;
use TsCloud\Serverless\Console\SqsHandleCommand;

/**
 * Registers the ts-cloud serverless runtime bridge for Laravel on AWS Lambda.
 *
 * This is the ts-cloud-owned alternative to laravel/vapor-core: it provides the
 * `tscloud:sqs-handle` command that the Lambda queue runtime invokes once per
 * SQS message (one job per invocation), avoiding the double-delivery hazard of
 * running stock `queue:work` alongside Lambda's own SQS poller.
 */
class ServerlessServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // no-op
    }

    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->commands([
                SqsHandleCommand::class,
            ]);
        }
    }
}
