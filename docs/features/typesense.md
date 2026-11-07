# Managed Typesense

Hetzner and SSH deployments can provision Typesense from the official Pantry
package on the application's own host:

```ts
infrastructure: {
  compute: {
    managedServices: {
      typesense: {
        version: '30.2',
        apiKey: process.env.TYPESENSE_API_KEY || '',
      },
    },
  },
}
```

Keep a stable random key in the deployment's encrypted environment. The key must
have 32-256 letters, digits, hyphens or underscores; an empty or development key
stops provisioning. Omitting `typesense`, or setting it to `false`, changes no
service.

The service binds its HTTP and peering ports to loopback by default. `port`
defaults to 8108, with peering on the adjacent lower port. A dedicated services
fleet must explicitly set `bindAddress` to its private IPv4 address; application
releases then use that host's private address. Explicit `site.env` values remain
authoritative.

Provisioning refuses ports owned by another process and never adopts an unknown
unit. The `ts-cloud-typesense.service` unit runs as its own system user, retains
data in `/var/lib/ts-cloud-typesense`, and loads its key from the root-only
`/etc/ts-cloud/typesense.env` file. The key appears in neither process arguments
nor the public unit environment. Replaying the same configuration preserves the
key and leaves an active service running. Changes to the binary, key or unit
restart this service only. Admission requires both a healthy engine and an
authenticated collection request.
Provisioning is serialized, and an applied-configuration record is saved only
after authentication succeeds, so a retry also repairs an interrupted key update.

Existing owned hosts reconcile the declared service on each deployment too.
An SSH bootstrap marker, or `TS_CLOUD_SSH_SKIP_BOOTSTRAP=1`, skips machine
bootstrap work while still applying service configuration and readiness checks.

The application receives matching `TYPESENSE_HOST`, `TYPESENSE_PORT`,
`TYPESENSE_PROTOCOL` and `TYPESENSE_API_KEY` settings. Dashboard responses redact
the key, and generic golden images exclude the authenticated instance. Attach
mode checks that the owner provides the declared engine and does not install it
on somebody else's server.

The optional real-host regression uses a Pantry-equipped Linux host reached as
root over SSH. It creates randomly named fixture resources, verifies real
authentication, data retention, private credentials and interrupted-update
recovery, then removes those resources:

```sh
TS_CLOUD_TYPESENSE_TEST_HOST=root@your-test-host \
TS_CLOUD_TYPESENSE_TEST_SSH_KEY=/path/to/existing/key \
bun test ./packages/ts-cloud/test/integration/typesense-host-e2e.test.ts
```

Existing application units and databases are never adopted. The Typesense
package remains installed through Pantry for subsequent deployments.
