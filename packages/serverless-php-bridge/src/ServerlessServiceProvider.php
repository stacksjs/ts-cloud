<?php

namespace TsCloud\Serverless;

use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;
use TsCloud\Serverless\Console\DbQueryCommand;
use TsCloud\Serverless\Console\SqsHandleCommand;
use TsCloud\Serverless\Http\SignedStorageUrlController;

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
                DbQueryCommand::class,
            ]);
        }

        // Direct browser → S3 upload endpoint (the Vapor.store() flow).
        Route::middleware('web')->post(
            '/tscloud/signed-storage-url',
            [SignedStorageUrlController::class, 'store'],
        );
    }
}
