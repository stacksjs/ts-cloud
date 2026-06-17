<?php

namespace TsCloud\Serverless\Queue;

use Illuminate\Container\Container;
use Illuminate\Contracts\Queue\Job as JobContract;
use Illuminate\Queue\Jobs\Job;

/**
 * A queue Job wrapping a single SQS message that AWS Lambda's event source
 * mapping already delivered. Message lifecycle (delete on success, retry/DLQ on
 * failure) is owned by Lambda + the event source mapping, so {@see delete()} and
 * {@see release()} are intentionally no-ops here — the command's exit status is
 * what signals success/failure back to the runtime.
 */
class LambdaSqsJob extends Job implements JobContract
{
    protected string $rawBody;
    protected int $receiveCount;

    public function __construct(
        Container $container,
        string $rawBody,
        string $connectionName,
        string $queue,
        int $receiveCount = 1
    ) {
        $this->container = $container;
        $this->rawBody = $rawBody;
        $this->connectionName = $connectionName;
        $this->queue = $queue;
        $this->receiveCount = max(1, $receiveCount);
    }

    /** {@inheritDoc} */
    public function getJobId(): string
    {
        $payload = $this->payload();
        return (string) ($payload['uuid'] ?? $payload['id'] ?? '');
    }

    /** {@inheritDoc} */
    public function getRawBody(): string
    {
        return $this->rawBody;
    }

    /** {@inheritDoc} */
    public function attempts(): int
    {
        return $this->receiveCount;
    }

    /** Lambda manages message deletion; mark deleted locally only. */
    public function delete(): void
    {
        parent::delete();
    }

    /** Lambda manages retries via the event source mapping; no-op. */
    public function release($delay = 0): void
    {
        parent::release($delay);
    }
}
