# Remote API compatibility policy

- `/api/v1` may add optional response fields and new endpoints.
- Existing fields, enum values, error meanings, and endpoint behavior are not removed or redefined within v1.
- Clients discover optional behavior through `/api/v1/meta` capabilities.
- Breaking changes require a new major URL and a transition period where both majors are served.
- The PC release pipeline must verify the current and previous released mobile contract fixtures.
