# ts-cloud TODO

## Pantry Registry Integration

### S3 Storage for Package Registry
**Status:** Not Started
**Description:** Use ts-cloud for S3 storage to keep everything open source and nicely abstracted. This powers the pantry registry storage backend.

**Tasks:**
- [ ] Add ts-cloud dependency to pantry registry package
- [ ] Implement S3 storage for package tarballs
- [ ] Implement S3 storage for package metadata
- [ ] Ensure abstraction allows for other cloud providers if needed

---

## Notes

- ts-cloud is the storage abstraction layer for the pantry registry
- Should support S3-compatible storage (AWS S3, R2, MinIO, etc.)
- Keep it wholly open source and nicely abstracted
