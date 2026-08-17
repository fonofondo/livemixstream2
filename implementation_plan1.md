# General Stack-Agnostic Implementation Plan

## 1. Goal

Commercial platform for organizations that coordinate PA audio support across multiple churches or venues.

The product should allow an organization to:

- Register many users without charging for every named account.
- Purchase a fixed number of simultaneous stream channels.
- Assign available channels to scheduled services and authorized operators.
- Prevent the organization from exceeding its purchased concurrent capacity.
- Monitor all active services from one operations view.
- Reassign operators without interrupting an active audio stream.
- Detect audio, network, endpoint, and staffing problems before or during a service.
- Maintain durable usage, assignment, incident, and audit history.

The main commercial unit is a **concurrent live stream**, not a named user.

---

## 2. Product vocabulary

- **Organization:** The customer that owns users, locations, subscriptions, and data.
- **Owner:** The person with final control of organization settings and billing.
- **Administrator:** Manages users, locations, endpoints, schedules, and permissions.
- **Supervisor:** Oversees active services and can reassign or terminate sessions.
- **Engineer/operator:** Monitors or manages an assigned service.
- **Local volunteer:** Performs local checks and communicates with remote personnel.
- **Viewer/listener:** Receives an authorized monitoring stream.
- **Location:** A church, campus, building, sanctuary, or venue.
- **Room:** A specific audio space within a location.
- **Endpoint:** An approved plugin, desktop bridge, or hardware device that sends or receives audio.
- **Service template:** A recurring service definition.
- **Service event:** One scheduled occurrence of a service.
- **Assignment:** A relationship between a person and a service event.
- **Stream entitlement:** The number of simultaneous streams purchased by an organization.
- **Stream lease:** A temporary claim on one unit of concurrent capacity.
- **Live session:** The runtime audio and control activity for one service event.
- **Media node:** A runtime component that receives, relays, and distributes live audio.

Use “concurrent streams” or “stream channels” in customer-facing language. Avoid calling them user seats.

---

## 3. Product boundary

### 3.1 Initial commercial scope

- Organization and user management.
- Roles and location-scoped permissions.
- Church locations, rooms, and approved endpoints.
- Recurring schedules and individual service events.
- Primary and backup operator assignments.
- Concurrent stream entitlement and lease enforcement.
- Real-time audio transmission from an endpoint.
- Authenticated browser monitoring.
- Supervisor dashboard for all active services.
- Audio and network telemetry.
- Pre-service readiness checks.
- Operational alerts and acknowledgement.
- Operator reassignment and supervisor takeover.
- Talkback between authorized participants.
- Durable audit and usage history.
- Subscription and entitlement lifecycle.
- Production deployment, support, backup, and recovery procedures.
- Installable, signed, versioned endpoint software.

### 3.2 Not required for the first release

- Replacing every manufacturer’s PA console-control application.
- Supporting every console brand.
- Large immersive or post-production channel formats.
- Public broadcast distribution to very large audiences.
- Native mobile applications if the responsive browser experience is sufficient.
- Automatic or AI-driven mixing.
- Audio recording by default.
- Lossless internet streaming as the default profile.

### 3.3 Later opportunities

- Direct console integrations.
- Managed on-site appliance.
- Redundant media paths.
- Recording and post-service review.
- External scheduling and church-management integrations.
- Enterprise identity integration.
- Self-hosted or white-label deployment.

---

## 4. Current implementation

The existing code provides a useful technical prototype with these capabilities:

- An audio plugin with Track Control and Streaming modes.
- Smooth sample-by-sample gain changes for ducking.
- A lock-free handoff between the real-time audio callback and network processing.
- Local coordination between plugin instances on one machine.
- Compressed real-time audio transmission.
- A central server for sessions, connected plugins, and hierarchy state.
- Browser delivery through a real-time media path.
- A secondary direct socket media fallback.
- Listener, hierarchy, administration, and transmitter-test web surfaces.
- Session creation and shareable listener links.
- Basic operational metrics and an audit view.
- Containerized server deployment.
- Cross-platform plugin builds and basic automated tests.

### 4.1 Existing strengths to preserve

- Network and encoding work stays outside the audio callback.
- Gain changes are gradual rather than abrupt.
- The server is authoritative for shared hierarchy state.
- Plugins retain the last commanded gain if the control connection is interrupted.
- The plugin/server/browser flow already demonstrates the core audio concept.
- The current administration page is a useful prototype for the future operations dashboard.

### 4.2 Existing limitations to replace

- One shared administrator password.
- No individual user accounts or organization boundaries.
- No persistent business state.
- No capacity entitlement or lease enforcement.
- No church locations, schedules, assignments, or operator availability.
- Some control actions can be performed without authentication.
- Endpoint identity can be supplied by the client rather than securely issued.
- Listener access is based mainly on possession of a session link.
- Server limits and rate controls exist only within one running process.
- A server restart loses sessions, hierarchy, audit history, and login state.
- One server process contains business APIs, realtime control, fallback media, and media routing.
- Difficult firewall and network environments are not fully handled.
- Audio and network measurements are too limited for professional PA operations.
- Actual audio encoding settings can differ from displayed session settings.
- Producer identifiers are not guaranteed to be unique.
- Disconnecting one plugin can clear the entire session hierarchy.
- Reading an unknown session can create a phantom session.
- More than one media path may be transmitted at the same time.
- The fallback media format is not fully negotiated or versioned.
- Automated tests do not yet prove tenant isolation, capacity correctness, network resilience, or long-duration audio accuracy.

---

## 5. Guiding architecture

The implementation should be divided into four logical areas. The exact languages, frameworks, storage engines, and hosting providers are implementation choices, not product requirements.

### 5.1 Control plane

Responsible for:

- Users, organizations, roles, and permissions.
- Locations, rooms, endpoints, and schedules.
- Assignments and staffing changes.
- Subscription status and purchased capacity.
- Atomic stream-lease allocation.
- Live-session lifecycle.
- Regional media placement.
- Auditing, reporting, notifications, and support operations.

### 5.2 Realtime control plane

Responsible for:

- Endpoint presence.
- Session state changes.
- Assignment and takeover events.
- Hierarchy commands.
- Telemetry summaries.
- Alert notifications.
- Talkback presence and signaling.

Realtime messages accelerate updates. Durable state must remain recoverable from the control plane after a reconnect.

### 5.3 Media plane

Responsible for:

- Receiving authenticated audio from endpoints.
- Relaying audio to authorized monitors.
- Handling network traversal and fallback.
- Collecting transport statistics.
- Closing revoked or expired media resources.
- Reporting health to the control plane.

The media plane should not own durable customer, billing, schedule, or audit records.

### 5.4 Client applications

- Owner and administrator application.
- Supervisor operations dashboard.
- Engineer/operator workspace.
- Local volunteer readiness view.
- Browser audio monitor.
- Audio plugin, desktop bridge, or site appliance.

### 5.5 Architectural principles

- Every tenant-owned resource belongs to exactly one organization.
- Capacity is enforced by the server, never only by the UI.
- Durable business state is independent from process memory.
- Active audio should survive short control-plane interruptions.
- All destructive and privileged actions are authenticated, authorized, and audited.
- Audio behavior must be measured under reproducible conditions.
- Runtime components may scale independently without changing product semantics.
- Begin with modular components; split into separate services only when reliability, scale, or team ownership requires it.

---

## 6. User roles and permissions

### 6.1 Organization owner

- Manage organization profile.
- Manage subscription and stream entitlement.
- Add or remove administrators.
- View all locations, sessions, audit events, and usage.
- Configure security and retention policy.

### 6.2 Administrator

- Invite and deactivate users.
- Assign roles and location scopes.
- Create locations, rooms, endpoints, and schedules.
- Assign personnel.
- View active and historical operations.
- Revoke endpoints and guest links.

### 6.3 Supervisor

- View all permitted live and upcoming services.
- Monitor health and listen to sessions.
- Acknowledge alerts.
- Reassign engineers.
- Take over or terminate a session.
- Record incident notes.

### 6.4 Engineer/operator

- View assigned services.
- Accept or decline assignments.
- Run preflight.
- Monitor the assigned session.
- Use talkback.
- Manage only the controls explicitly permitted for that service.

### 6.5 Local volunteer

- View a simplified local schedule.
- Run endpoint and audio checks.
- Contact the assigned engineer.
- Use approved local talkback controls.

### 6.6 Viewer/listener

- Listen only to explicitly authorized sessions.
- Receive no mix-control permission unless separately granted.

### 6.7 Authorization requirements

- A user’s role is scoped to an organization.
- Access may be further limited to specific locations.
- Assignment does not automatically imply organization-wide access.
- Privileged actions are checked when performed, not only when the page loads.
- A reassignment immediately changes control permissions.
- Support personnel receive only explicit, time-limited customer-approved access.

---

## 7. Core domain model

The persistent domain should include the following logical records.

### 7.1 Identity and tenancy

- User.
- Organization.
- Organization membership.
- Role and permission scope.
- Invitation.
- Login session.
- Verification, recovery, and multi-factor credentials.

### 7.2 Church operations

- Location.
- Room.
- Endpoint.
- Endpoint capabilities and software version.
- Service template.
- Service event.
- Assignment.
- Assignment acceptance and history.
- Preflight run and individual check results.

### 7.3 Commercial capacity

- Product plan.
- Subscription.
- Entitlement.
- Stream lease.
- Usage event.
- Manual entitlement override with reason and expiry.

### 7.4 Runtime operations

- Live session.
- Session participant.
- Session state transition.
- Hierarchy group and track state.
- Telemetry summary.
- Alert.
- Incident.
- Audit event.

### 7.5 Supporting records

- Notification preference.
- Notification delivery.
- Billing event.
- Guest access grant.
- Support access grant.
- Software release and endpoint compatibility policy.

### 7.6 Data rules

- Use stable internal identifiers and separate human-friendly codes where needed.
- Every tenant-owned record carries organization ownership.
- Relationships prevent a session, endpoint, assignment, or lease from crossing organizations.
- Important state changes are append-only or historically traceable.
- High-frequency raw measurements use bounded retention.
- Business summaries and incidents remain durable.
- Secrets are stored only in protected credential storage and never in project files or logs.

---

## 8. Concurrent stream capacity

This is the central commercial feature.

### 8.1 Required behavior

- An organization has a current maximum concurrent-stream entitlement.
- Starting a live session requests one stream lease.
- The server grants or rejects the request atomically.
- Multiple simultaneous requests cannot exceed the entitlement.
- Duplicate retries return the original result rather than consuming another channel.
- A session keeps its lease during an operator reassignment.
- A normal stop releases capacity immediately.
- A temporary endpoint disconnect preserves capacity for a defined grace period.
- A stale or abandoned stream is eventually released automatically.
- Supervisors can see which service holds every active channel.
- Forced release requires permission, confirmation, reason, and audit.

### 8.2 Lease lifecycle

Recommended logical states:

- Requested.
- Active.
- Renewing.
- Reconnecting.
- Releasing.
- Released.
- Expired.
- Revoked.

### 8.3 Acquire operation

The capacity authority must perform these steps as one indivisible operation:

1. Verify organization and subscription status.
2. Verify endpoint, event, assignment, and actor permissions.
3. Remove or mark expired claims.
4. Return an existing lease for a duplicate request.
5. Count valid active leases.
6. Reject if the purchased limit is reached.
7. Create one lease and associated live session.
8. Commit the allocation before issuing media credentials.

### 8.4 Heartbeat and recovery

- The endpoint renews the lease at a fixed interval.
- Lease expiry is longer than the heartbeat interval.
- Short control-plane failures do not stop active audio immediately.
- Reconnect within the grace period resumes the same session and lease.
- A reconciliation process repairs mismatches among leases, sessions, and media resources.
- All stop, release, and reconciliation actions are safe to retry.

### 8.5 Capacity acceptance tests

- Simultaneous requests for the final channel produce exactly one new successful lease.
- Retried start requests never create duplicate leases.
- Process failure during a start does not leak capacity.
- Expired sessions release capacity within the documented interval.
- Reassignment does not consume another channel.
- Upgrades expose new capacity without service restart.
- Downgrades follow a defined policy when current use exceeds the future limit.
- Billing failure does not unexpectedly terminate an active service.

---

## 9. Scheduling and assignment

### 9.1 Service scheduling

- Create one-time and recurring service templates.
- Store the organization and location timezones.
- Materialize future service events.
- Handle daylight-saving changes.
- Permit per-event exceptions.
- Support setup, preflight, service, and teardown windows.
- Detect room or endpoint conflicts.

### 9.2 Personnel assignment

- Primary engineer.
- Backup engineer.
- Local volunteer or contact.
- Assignment acceptance or decline.
- Overlap and availability warnings.
- Location and skill eligibility.
- Supervisor override with reason.
- Escalation when an assignment is unaccepted near start time.

### 9.3 Assignment notifications

- Invitation.
- New or changed assignment.
- Acceptance reminder.
- Preflight reminder.
- Service starting soon.
- Backup activation.
- Reassignment.
- Cancellation.
- Incident follow-up.

Notification delivery failure must be visible and retryable.

---

## 10. Endpoint registration and operation

### 10.1 Endpoint types

Support a common endpoint model for:

- Existing DAW plugin.
- Standalone desktop site bridge.
- Future managed hardware appliance.

Each endpoint declares capabilities such as audio inputs, supported formats, talkback, local control, and software version.

### 10.2 Registration

1. Administrator creates a short-lived activation code.
2. Endpoint exchanges it for a permanent endpoint identity.
3. Long-lived credentials are stored in the operating system or device credential store.
4. Endpoint requests short-lived access credentials for normal operation.
5. Administrator assigns the endpoint to a location and room.
6. Endpoint can be revoked independently of users.

Do not trust a device identity supplied only as a query parameter or editable text field.

### 10.3 Endpoint state model

- Unregistered.
- Activated.
- Offline.
- Connecting.
- Ready.
- Preflight failed.
- Awaiting assignment.
- Awaiting capacity.
- Starting.
- Live.
- Degraded.
- Reconnecting.
- Stopping.
- Ended.
- Revoked.
- Upgrade required.

Each transition has:

- A timestamp.
- A typed reason.
- A visible user message.
- A retry or escalation policy.
- An audit event when operationally important.

### 10.4 Endpoint interface

Display:

- Organization and location.
- Assigned service and operator.
- Input device and format.
- Preflight state.
- Capacity state.
- Connection and transport state.
- Actual codec profile.
- Audio and network health.
- Start, stop, test, and talkback controls as permitted.

Store non-secret session settings in project state. Store authentication credentials separately.

---

## 11. Session lifecycle

Recommended session states:

- Planned.
- Preflight.
- Ready.
- Capacity requested.
- Starting.
- Live.
- Degraded.
- Reconnecting.
- Ending.
- Ended.
- Failed.
- Cancelled.

### 11.1 Start

1. Validate event and assignment.
2. Validate endpoint readiness.
3. Acquire concurrent capacity.
4. Select a healthy media region/node.
5. Issue short-lived session-bound credentials.
6. Start media transmission.
7. Confirm monitorable audio.
8. Mark the session live.
9. Notify assigned personnel and supervisors.

### 11.2 Reassignment

- Replace the controlling operator without restarting media.
- Revoke the previous operator’s control permission immediately.
- Optionally retain monitor-only access according to policy.
- Preserve the same lease and live session.
- Record assignment history and audit events.

### 11.3 End

- Stop accepting new listeners.
- Close or drain media resources.
- Release the stream lease.
- Produce final usage and health summaries.
- Resolve or carry forward open alerts.
- Notify relevant participants.
- Preserve the operational timeline.

---

## 12. Realtime control and event contract

### 12.1 Connection

- Client obtains short-lived realtime authorization.
- Connection binds user or endpoint identity, organization, role, and resource scope.
- Subscription channels are limited to permitted locations and sessions.
- Privileged commands are authorized again when received.
- Reconnect obtains an authoritative snapshot before applying new events.

### 12.2 Standard event fields

- Event type.
- Schema version.
- Unique event ID.
- Organization ID.
- Resource ID.
- Server timestamp.
- Correlation and causation IDs.
- Resource revision where ordering matters.

### 12.3 Event categories

- Endpoint presence and version.
- Schedule and assignment.
- Preflight.
- Capacity lease.
- Session lifecycle.
- Participant presence.
- Hierarchy and control state.
- Telemetry.
- Alerts and incidents.
- Talkback presence.
- Billing/entitlement state relevant to operations.

### 12.4 Event reliability

- Events are validated against versioned schemas.
- Commands and notifications are distinct.
- Duplicate events are safe.
- Important state can be reconstructed from durable records.
- Clients detect gaps and request a new snapshot.
- Old client versions receive a clear compatibility error.

---

## 13. Audio transport and processing

### 13.1 Initial network audio profile

Define one supported profile for the first release:

- Fixed network sample rate.
- Mono/stereo channel policy.
- Music-appropriate compressed codec profile.
- Explicit packet duration.
- Configurable but truthful bitrate.
- Error concealment settings where supported.
- Sequence numbers and continuous timestamps.
- Unique producer identifiers.
- One selected media path per session.

The displayed audio profile must exactly match the actual encoder.

### 13.2 Real-time audio rules

The audio callback:

- Performs no network or file operations.
- Takes no locks.
- Allocates no memory.
- Uses bounded processing.
- Writes to a preallocated lock-free handoff.
- Records overload/drop counters without blocking.

Encoding, packet creation, authentication, reconnect, metrics aggregation, and logging run outside the audio callback.

### 13.3 Format conversion

- Define the canonical network format.
- Convert unsupported device/host sample rates using a high-quality asynchronous converter.
- Specify mono/stereo mapping.
- Handle varying audio block sizes.
- Detect clock drift and discontinuities.
- Report inserted, dropped, or resampled frames.
- Reset transport state explicitly after audio-device changes.

### 13.4 Primary and fallback path

- Select one primary media path for each session.
- Use a network traversal fallback for restrictive networks.
- If a separate socket media fallback remains, define a versioned framing protocol containing codec, sample format, channels, timestamps, sequence, and discontinuity information.
- Never identify raw audio as compressed audio.
- Never send both primary and fallback media concurrently unless deliberate redundancy is implemented and measured.

### 13.5 Track hierarchy

The current implementation supports independent duck/unduck switches. The product must explicitly choose:

- Independent switches.
- Exclusive lead.
- Priority groups.
- A combination selected per group.

For every mode:

- Define initial state.
- Define behavior on control disconnect.
- Define operator permissions.
- Preserve state across reconnect.
- Prevent one plugin disconnect from removing unrelated tracks.
- Measure commanded gain, resulting gain, and fade timing.

---

## 14. Audio and network telemetry

### 14.1 Audio measurements

- Input and network sample rate.
- Channel count and mapping.
- Audio callback block size.
- Actual codec, bitrate, and packet duration.
- Queue fill, overruns, underruns, and dropped frames.
- Sample peak.
- True peak using a documented method.
- Momentary, short-term, and integrated loudness using a recognized standard.
- Silence duration.
- Clipping events.
- Channel imbalance.
- Missing-channel detection.
- Transport discontinuities.

### 14.2 Network measurements

- Round-trip time.
- One-way or end-to-end playout latency when truly measured.
- Jitter.
- Packet loss.
- Late and reordered packets.
- Bytes and packets transmitted.
- Current network path/fallback.
- Reconnect count and duration.
- Listener count.

Do not display a target buffer value or round-trip time as measured one-way end-to-end latency.

### 14.3 Telemetry storage

- Retain high-frequency values for a bounded period.
- Produce lower-frequency summaries for customer history.
- Preserve important threshold crossings and incidents.
- Associate every measurement with organization, location, endpoint, session, and time.
- Make retention configurable by product tier or policy.

---

## 15. Preflight and alerting

### 15.1 Preflight checks

- Endpoint online and authorized.
- Supported endpoint software version.
- Expected input device present.
- Expected sample rate and channels available.
- Signal detected.
- No sustained clipping during test.
- Both expected channels present.
- Media destination reachable.
- Primary and fallback network paths tested.
- Packet loss, jitter, and latency probe.
- Talkback test.
- Assigned primary/backup personnel confirmed.
- Current capacity availability displayed.

Capacity should not be reserved long before a service unless the product introduces an explicit reservation policy.

### 15.2 Alert rules

- Endpoint offline.
- Stream failed to start.
- Silence beyond threshold.
- Sustained clipping or excessive true peak.
- Loudness outside configured range.
- Missing channel or severe imbalance.
- Excessive packet loss, jitter, or latency.
- Audio queue overflow.
- Encoder failure.
- Repeated reconnect.
- Lease near expiry or stale.
- Assigned operator absent.
- Unsupported endpoint version.

### 15.3 Alert behavior

- Severity levels.
- Minimum duration before opening.
- Hysteresis before resolving.
- Deduplication.
- Escalation.
- Acknowledgement and owner.
- Notes and resolution.
- Notification history.
- Link to the affected session timeline.

---

## 16. Talkback

- Use a separate authenticated audio path from the program stream.
- Restrict participants by session role.
- Provide push-to-talk.
- Clearly indicate who is speaking.
- Route talkback only to the intended endpoint or monitor bus.
- Keep it out of public listener audio by default.
- Define behavior during reconnect.
- Provide setup guidance to prevent feedback.
- Audit participation and administrative override, but do not retain talkback audio by default.

Talkback latency and reliability must be measured separately from program audio.

---

## 17. Web application requirements

### 17.1 Owner/administrator

- Organization settings.
- Subscription and capacity.
- Users, roles, and invitations.
- Locations, rooms, and endpoints.
- Schedules and assignments.
- Security settings.
- Usage and audit reports.

### 17.2 Supervisor operations view

Show:

- Scheduled, preflight, ready, starting, live, degraded, and ended services.
- Location and room.
- Primary and backup personnel.
- Endpoint and software status.
- Stream channels used and available.
- Actual audio format.
- Loudness, true peak, silence, packet loss, jitter, and latency.
- Active alerts.
- Session duration and timeline.

Provide:

- Listen.
- Talkback.
- Acknowledge alert.
- Reassign.
- Take over.
- End session.
- Add incident note.

### 17.3 Engineer/operator

- Assigned schedule.
- Accept/decline.
- Preflight checklist.
- Authenticated low-latency monitor.
- Talkback.
- Session health.
- Permitted mix/hierarchy controls.
- Escalation and incident notes.

### 17.4 Local volunteer

- Simplified next-service view.
- Endpoint readiness.
- Guided input test.
- Talkback/contact.
- Clear action for failed checks.

### 17.5 Listener

- Explicit session identity and status.
- Start/stop monitoring.
- Volume and mute.
- Actual stream format and measured health where appropriate.
- Reconnect state.
- No control features unless authorized.

### 17.6 Accessibility and resilience

- Keyboard access.
- Screen-reader labels.
- Status not communicated by color alone.
- Responsive tablet/mobile layout.
- Clear stale/offline state.
- Snapshot recovery after realtime reconnect.
- Confirmation for destructive actions.

---

## 18. Identity and security

### 18.1 User authentication

- Individual accounts.
- Verified contact address.
- Strong password hashing when passwords are used.
- Secure reset and recovery.
- Optional or required multi-factor authentication by role.
- Secure browser sessions not exposed to normal page scripts.
- Session rotation and revocation.
- Brute-force and abuse controls shared across application instances.

### 18.2 Endpoint authentication

- One-time activation.
- Device-specific credentials.
- Short-lived operating credentials.
- Session-bound media authorization.
- Endpoint revocation.
- Version and capability claims verified by the service.

### 18.3 Access control

- Authenticate all state-changing actions.
- Enforce organization boundaries.
- Enforce role and location scope.
- Validate every API request and realtime message.
- Limit payload size, command rate, and connection rate.
- Use short-lived guest links with revocation.
- Do not place reusable secrets in URLs.

### 18.4 Platform security

- Encrypted transport.
- Protected secrets.
- Encryption for stored data and backups.
- Least-privilege component identities.
- Dependency and release scanning.
- Signed endpoint releases.
- Security headers and browser protections.
- Immutable or tamper-evident audit records.
- Backup restoration exercises.
- Incident response and vulnerability reporting process.

### 18.5 Privacy

- Publish collected data categories and retention.
- Do not record audio by default.
- Make recording explicit and visible.
- Support account and organization data export/deletion.
- Redact credentials and sensitive values from diagnostics.
- Obtain legal review of customer terms and privacy obligations.

---

## 19. Subscription and entitlement

### 19.1 Commercial model

Primary limit:

- Maximum simultaneous live streams.

Optional secondary limits:

- Number of locations.
- Telemetry retention.
- Recording storage.
- Support level.
- Enterprise identity.
- Managed or self-hosted deployment.

### 19.2 Entitlement lifecycle

- New subscription creates pending entitlement.
- Verified billing events activate or change entitlement.
- Duplicate and out-of-order billing events are safe.
- Upgrade may add capacity immediately.
- Downgrade follows a documented effective date.
- Failed payment enters a grace policy.
- Cancellation blocks future use according to policy.
- Active Sunday services are not unexpectedly terminated by delayed billing state.
- Manual support overrides require reason, expiry, and audit.

### 19.3 Usage records

Record:

- Lease acquired and released.
- Service and location.
- Start and end time.
- Duration.
- Peak concurrency.
- Media region.
- Transmitted data.
- End reason.
- Manual override.

Usage history should explain invoices and capacity decisions without requiring raw packet logs.

---

## 20. Persistence and state ownership

The implementation requires:

- A durable transactional store for business and authorization state.
- A shared short-lived state mechanism for presence, event distribution, leases, rate controls, or job coordination where appropriate.
- A time-series/metrics facility for high-frequency operational measurements.
- Durable file/object storage only for approved artifacts such as diagnostics or recordings.
- A background work mechanism for notifications, reconciliation, reports, and cleanup.

### 20.1 State ownership rules

- User, organization, subscription, schedule, assignment, lease, and audit state are durable.
- Realtime connections and media transports are ephemeral.
- The current live state can be reconstructed after component restart.
- One authoritative component owns each state transition.
- Caches never override durable authorization or entitlement.
- Background work is idempotent and retryable.

---

## 21. Reliability and scale

### 21.1 Control plane

- Multiple application instances can operate concurrently.
- No correctness depends on process-local memory.
- Realtime events reach clients connected to different instances.
- Scheduled work can run redundantly without duplicate effects.
- Deployments do not require stopping active sessions.

### 21.2 Media plane

- Media nodes report capacity and health.
- Sessions are placed on healthy nodes.
- Each producer has unique transport identity.
- Network traversal works in restrictive environments.
- Nodes can enter drain mode.
- Active sessions remain pinned unless a tested recovery strategy exists.
- Media failure has a defined reconnect or failover policy.

### 21.3 Failure behavior

Define and test:

- Control API unavailable while audio remains active.
- Realtime gateway restart.
- Durable store unavailable.
- Shared state/event facility unavailable.
- Media worker or node crash.
- Network traversal service outage.
- Endpoint network change.
- Plugin or desktop bridge crash.
- Billing service outage.
- Notification service outage.

### 21.4 Service objectives

Measure before promising:

- Availability.
- Session-start success.
- Time to monitorable audio.
- Reconnect success and duration.
- Audio dropout rate.
- Alert detection delay.
- Capacity allocation correctness.
- Support response and recovery time.

Numerical objectives should be established from staging and pilot evidence.

---

## 22. Observability and support

### 22.1 Diagnostic context

Every relevant log, metric, trace, and event should carry:

- Correlation ID.
- Organization.
- Location.
- Endpoint.
- Service event.
- Live session.
- Stream lease.
- Media node/region.
- Endpoint software version and operating environment.

### 22.2 Internal dashboards

- Start attempts, success, and failure reasons.
- Active leases versus entitlement.
- Session health.
- Media capacity and saturation.
- Loss, jitter, latency, and dropout distributions.
- Endpoint versions.
- Alert volume and acknowledgement.
- API/realtime failures.
- Billing and notification processing failures.

### 22.3 Support tools

- Search by organization, location, endpoint, event, or session.
- View a redacted session timeline.
- Revoke a user, endpoint, guest link, or session.
- Release stale capacity.
- Retry safe background operations.
- Create time-limited support access.
- Export a consented diagnostics bundle.
- Audit all support actions.

Never expose passwords, refresh credentials, full tokens, or raw audio in support tools.

---

## 23. Testing and precise audio validation

### 23.1 Test levels

- Domain unit tests.
- Audio processing tests.
- Storage and migration tests.
- Authorization and tenant-isolation tests.
- API contract tests.
- Realtime protocol tests.
- Media integration tests.
- Endpoint integration tests.
- Browser workflow tests.
- Load and spike tests.
- Long-duration soak tests.
- Failure and chaos tests.
- Security tests.

### 23.2 Deterministic audio harness

Create a headless reference transmitter and receiver that can:

- Generate tones, impulses, sweeps, noise, silence, and reference audio.
- Capture decoded output.
- Compare level, timing, channel mapping, dropouts, and spectral behavior.
- Apply repeatable network impairment.
- Produce machine-readable reports.

### 23.3 Audio test matrix

- Common host/device sample rates.
- Mono and stereo.
- Small, large, and irregular callback block sizes.
- Different codec bitrates and packet durations.
- Long continuous sessions.
- Queue overload.
- Packet loss, burst loss, jitter, duplication, and reordering.
- Reconnect and network-path changes.
- Clock drift.
- CPU and bandwidth pressure.
- Multiple simultaneous sessions and listeners.

### 23.4 Measurement definitions

Document:

- Where latency begins and ends.
- One-way versus round-trip measurement.
- Configured buffering versus measured playout.
- Loudness standard and gating.
- True-peak method and tolerance.
- Dropout definition.
- Fade timing and gain tolerance.
- Packet loss and jitter calculation.
- Clock-drift correction.

### 23.5 Required evidence

- No allocation or blocking in the audio callback.
- No unexplained discontinuity on a clean path.
- Actual format matches displayed format.
- Gain and fade results meet stated tolerance.
- Known behavior under impairment.
- Exact capacity enforcement under concurrent load.
- Cross-organization access fails.
- Multi-hour realistic Sunday simulations pass.
- Backup restoration succeeds.

---

## 24. Delivery and release process

The delivery pipeline should perform:

- Source formatting and static checks.
- Unit and integration tests.
- Native audio tests on supported operating systems.
- Endpoint/plugin validation.
- Security and dependency scanning.
- Version and protocol compatibility checks.
- Reproducible artifact creation.
- Artifact signing and platform notarization where required.
- Staging deployment.
- Automated smoke tests.
- Safe data migration checks.
- Staged production rollout.
- Rollback verification.

### 24.1 Compatibility

- Version APIs and realtime/media protocols.
- Advertise supported endpoint version ranges.
- Maintain compatibility with at least the previous supported endpoint release during rollout.
- Reject incompatible clients with an actionable upgrade message.
- Use additive data changes before removing old fields.

### 24.2 Endpoint releases

- Signed installers.
- Clear supported operating system and host matrix.
- Guided activation.
- Stable and pilot release channels.
- Controlled update rollout.
- Emergency rollback.
- Optional privacy-preserving crash diagnostics.

---

## 25. Migration from the current prototype

### 25.1 Preserve

- Audio callback separation from networking.
- Lock-free audio handoff concept.
- Smooth gain ramp.
- Existing compressed audio and browser-delivery proof of concept.
- Local plugin coordination where useful.
- Session and hierarchy behavior as a prototype reference.
- Existing administration and listener UX as design input.
- Cross-platform build foundation.

### 25.2 Refactor

- Divide the large server entry point into domain modules.
- Replace in-memory business state with durable state ownership.
- Replace the shared admin password with individual identities.
- Replace self-asserted plugin identity with endpoint activation.
- Separate session control from media runtime.
- Turn hierarchy commands into authorized organization/session operations.
- Split the endpoint network implementation into authentication, signaling, encoding, packetization, transport, state machine, and telemetry components.
- Introduce explicit protocol versions and message validation.

### 25.3 Remove or replace

- Session creation from read operations.
- Unauthenticated mix changes.
- Optional production endpoint authentication.
- Shared production default credentials.
- Fixed producer identity.
- Whole-hierarchy removal when one endpoint disconnects.
- Concurrent primary and fallback transmission.
- Unspecified binary fallback framing.
- Process-local capacity and security controls.

### 25.4 Compatibility approach

- Treat the current protocol as prototype version zero.
- Build the commercial API and event contract as version one.
- Keep any temporary compatibility adapter isolated.
- Do not migrate prototype credentials into production.
- Define a removal date for the compatibility path before commercial release.

---

## 26. Implementation phases

Each phase ends with verifiable acceptance criteria. Phases may overlap only where dependencies allow.

### Phase 0 — Customer and workflow validation

Deliver:

- Interviews with PA support organizations and multi-site churches.
- Detailed Sunday workflow.
- Inventory of consoles, computers, audio interfaces, control software, and network conditions.
- Peak concurrency and staffing profile.
- Confirmation of plugin versus standalone bridge versus appliance.
- Confirmation whether direct console control is required for v1.
- Pilot organizations and measurable success criteria.

Exit:

- At least two pilot organizations validate concurrent-stream pricing.
- One narrow first-release workflow is agreed.
- The initial endpoint type is selected.
- Console control has an explicit v1 decision.

### Phase 0A — Prototype stabilization

Deliver:

- Disconnect one plugin without clearing unrelated hierarchy.
- Unknown session reads return not found.
- All mix changes require authorization.
- Endpoint connections require issued identity.
- Production has no default shared credential.
- Unique media producer identity.
- Exactly one negotiated media path per session.
- Correct and documented hierarchy semantics.
- Integration tests and operational health checks.

Exit:

- One full rehearsal completes without hierarchy loss, unauthorized control, phantom sessions, or duplicate media transmission.

### Phase 1 — Application foundation

Deliver:

- Modular domain boundaries.
- Versioned command, API, and event contracts.
- Durable state and migrations.
- Shared realtime/presence support.
- Background work and notification foundation.
- Local development and automated test environment.
- Expanded delivery pipeline.

Exit:

- A new environment can be created from versioned definitions.
- Data upgrades are automated and tested.
- Contract and integration tests run automatically.
- Prototype compatibility is isolated.

### Phase 2 — Organizations, identity, and permissions

Deliver:

- Users, organizations, memberships, invitations, and roles.
- Location-scoped access.
- Secure login, verification, recovery, and administrator MFA.
- Endpoint activation and revocation.
- Durable audit events.

Exit:

- Two organizations cannot access each other’s resources through any tested interface.
- Every privileged action records the actual actor.
- No shared production login remains.

### Phase 3 — Locations, schedules, and assignments

Deliver:

- Locations, rooms, and endpoint inventory.
- Recurring service templates and materialized events.
- Assignment, backup, acceptance, and conflict handling.
- Notifications.
- Calendar and personal assignment views.

Exit:

- A complete recurring Sunday schedule can be managed across locations.
- Exceptions and timezone transitions work.
- Assignment changes are immediate and auditable.

### Phase 4 — Subscription entitlement and stream leases

Deliver:

- Plans, subscriptions, entitlements, leases, and usage records.
- Atomic acquire, renew, release, expire, and reconcile behavior.
- Capacity dashboard.
- Clear capacity-exhausted workflow.
- Audited support override.

Exit:

- Concurrency tests never exceed purchased capacity.
- Duplicate starts never create duplicate claims.
- Failures and reconnects do not leak capacity.

### Phase 5 — Authenticated production media

Deliver:

- Session-bound producer and listener authorization.
- Media node selection and health.
- Unique session transport identity.
- Reliable network traversal.
- One canonical media path.
- Endpoint reconnect state machine.
- Correct sample-rate/channel handling.

Exit:

- Unauthorized producers and listeners are rejected.
- Public-network tests pass on direct and fallback paths.
- Short control-plane interruptions do not unnecessarily stop audio.
- Actual and displayed audio settings agree.

### Phase 6 — Preflight, telemetry, and alerts

Deliver:

- Objective audio and network measurements.
- Standards-defined loudness and true peak.
- Queue/dropout/discontinuity counters.
- Guided preflight.
- Alert rules, hysteresis, escalation, acknowledgement, and history.

Exit:

- Reference measurements meet defined tolerance.
- Injected failures produce the correct alerts.
- Measured latency is clearly separated from target buffering and round-trip time.

### Phase 7 — Operations dashboard and reassignment

Deliver:

- Organization-wide live service view.
- Capacity, staffing, endpoint, audio, and network status.
- Authenticated monitoring.
- Reassignment and takeover.
- Incident notes and timelines.
- Engineer and volunteer workflows.

Exit:

- A supervisor can manage a realistic simultaneous Sunday simulation.
- Reassignment does not interrupt audio or consume another stream.
- All privileged actions are authorized and audited.

### Phase 8 — Talkback and endpoint productization

Deliver:

- Separate talkback path.
- Commercial endpoint activation flow.
- Protected endpoint credentials.
- Signed installers and update mechanism.
- Compatibility and supported-environment policy.

Exit:

- Talkback reaches only intended recipients.
- Installation and activation require no development tools.
- Update and rollback are tested.

### Phase 9 — Billing, production operations, and support

Deliver:

- Checkout/account-management integration.
- Verified billing event processing.
- Upgrade, downgrade, grace, cancellation, and support-override policy.
- Production environment definitions.
- Backup and point-in-time recovery.
- Monitoring, paging, runbooks, and support tools.
- Privacy, retention, and customer policy.

Exit:

- Billing retries and event reordering are safe.
- Restore and incident drills pass.
- Support can diagnose a session without unrestricted customer access.

### Phase 10 — Pilot and commercial release

Deliver:

- Real Sunday pilots.
- Reliability and audio reports.
- Release-candidate hardening.
- Customer onboarding and training.
- Support and status communication.

Exit:

- Multiple consecutive pilots meet agreed criteria.
- No unresolved critical security, capacity, audio-integrity, or data-loss issue.
- Rollback, revocation, incident, and communication procedures are rehearsed.

### Phase 11 — Console integrations

Deliver only after product validation:

- Select first console family from pilot evidence.
- Define a capability-based integration contract.
- Begin with read-only status and metering.
- Add guarded control operations only where safe.
- Test against physical consoles and supported firmware.
- Preserve local fail-safe operation.

Exit:

- Supported commands behave predictably on documented hardware.
- Loss of cloud connectivity cannot leave the PA in an unsafe state.

---

## 27. Recommended first vertical slice

Build and validate this complete scenario before broad expansion:

1. Create one organization.
2. Add an owner, supervisor, and two engineers.
3. Create two church locations.
4. Schedule one service at each location.
5. Assign engineers.
6. Give the organization one concurrent stream.
7. Activate one endpoint per location.
8. Start the first service and acquire capacity.
9. Reject the second simultaneous start with a clear explanation.
10. Deliver authenticated monitor audio to the assigned engineer.
11. Show objective health to the supervisor.
12. Reassign the active service without restarting audio.
13. End the first service and release capacity.
14. Start the second service.
15. Confirm durable usage, assignment, alert, and audit history.

This slice proves the unique product value before advanced integrations are added.

---

## 28. Release gates

### 28.1 Product

- Organization can onboard without engineering assistance.
- Users and endpoints can be invited, activated, scoped, and revoked.
- Schedules and assignments work across timezones.
- Capacity is exact under concurrency.
- Reassignment does not interrupt media.

### 28.2 Audio

- Supported audio profile is documented.
- Displayed settings match actual transmission.
- Audio callback safety is verified.
- Sample-rate conversion and channel mapping are tested.
- Gain, fade, latency, and dropout measurements have defined tolerances.
- Long-duration and impaired-network tests pass.

### 28.3 Security

- Individual identities and tenant isolation.
- All control operations authorized.
- Endpoint, listener, realtime, and media credentials scoped and revocable.
- No unresolved critical security findings.
- Recovery and support access are audited.

### 28.4 Reliability

- Restart and dependency failure behavior is documented and tested.
- Backups restore successfully.
- Media resources can be drained or replaced safely.
- Capacity cannot leak after crashes.
- Operations dashboards and alerts cover agreed service indicators.

### 28.5 Commercial operations

- Subscription changes correctly change future capacity.
- Invoices can be explained from usage.
- Terms, privacy, retention, and support boundaries are documented.
- Pilot customers validate the workflow and pricing.

---

## 29. Decisions required before implementation

1. Is the primary endpoint the existing plugin, a standalone bridge, or an appliance?
2. Do churches run a DAW during services?
3. Is direct console control required for the first paid pilot?
4. Which console and audio-interface families dominate the target market?
5. Is the transmitted source the PA mix, a dedicated monitor bus, or selectable stems?
6. Which users may listen and which may change hierarchy state?
7. Are independent duck switches or exclusive lead semantics required?
8. Is talkback required for the first pilot?
9. What reconnect grace period is acceptable?
10. What should happen when capacity is exhausted immediately before a service?
11. What is the first realistic concurrent-session and listener load?
12. Which geographic regions are required?
13. What telemetry retention is commercially useful?
14. Is managed cloud sufficient, or is customer-hosted deployment required?
15. What availability and support expectations will be sold?

---

## 30. Definition of success

The system is successful when an organization can maintain many authorized users and church locations while paying for its actual peak simultaneous streaming requirement; administrators can schedule and assign services; the server enforces capacity exactly; supervisors can see, hear, and intervene in all active services; engineers receive reliable and precisely measured audio; and the platform remains secure, auditable, recoverable, and supportable without depending on a particular implementation stack.
