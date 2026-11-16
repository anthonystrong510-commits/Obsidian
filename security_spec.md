# Obsidian Vault Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. A user document `/users/{userId}` can only be created by the verified owner (`request.auth.uid == userId`), and `role` MUST be `'user'` and `status` MUST be `'active'` on self-registration (preventing self-assigned admin escalation).
2. PII (`email`) is strictly isolated into `/users/{userId}/private/info` and is readable/writable only by the verified owner or an authenticated admin.
3. User wallets (`/users/{userId}/wallets/{walletId}`), connected sessions (`/users/{userId}/connected_sessions/{sessionId}`), and alerts (`/users/{userId}/alerts/{alertId}`) require `ownerUid == userId`, valid IDs (`^[a-zA-Z0-9_\-]+$`, max 128 chars), and server timestamps (`request.time`). Verified admins may also provision/manage user wallets on `/users/{userId}/wallets/{walletId}`.
4. Only verified admins (`isAdmin()`) may create, update, or delete `/wallet_catalog/{walletId}`, `/exchange_wallets/{walletId}`, `/system_config/{configId}`, `/admins/{adminUid}`, or append to `/admin_audit_logs/{logId}`. Verified users may only read enabled entries in `/wallet_catalog/{walletId}` (`resource.data.enabled == true`).
5. `admin_audit_logs` are immutable once created (`allow update, delete: if false`).
6. Every `isAdmin()` check that inspects `request.auth.token.email` strictly requires `request.auth.token.email_verified == true`.

## 2. The "Dirty Dozen" Attack Payloads (Expected: PERMISSION_DENIED)
1. **Self-Admin Escalation on Signup**: `POST /users/{uid}` with `{ role: "admin", status: "active", ... }` -> Denied because `incoming().role == 'user'` is enforced.
2. **Role Tampering on Profile Update**: `PATCH /users/{uid}` as owner adding `role: "admin"` -> Denied by `affectedKeys().hasOnly(['displayName', 'walletCount', 'updatedAt'])`.
3. **Shadow Ghost Field Injection**: `POST /users/{uid}/wallets/{wid}` with extra field `isWhitelisted: true` -> Denied by `keys().hasOnly(...)`.
4. **Cross-Tenant Wallet & Session Hijack**: User A attempts to create/read `/users/{userB}/wallets/{wid}` or `/users/{userB}/connected_sessions/{sid}` -> Denied by `isOwner(userId)` + `ownerUid == request.auth.uid`.
5. **Unverified Email Spoofing Admin**: Token with `email: "obsidianvault99@gmail.com"` and `email_verified: false` reads `/exchange_wallets` or writes `/wallet_catalog` -> Denied because `email_verified == true` is mandated.
6. **Non-Admin Wallet Catalog Injection**: Regular user writes `/wallet_catalog/{id}` -> Denied by `isAdmin()`.
7. **Disabled Catalog Entry Scraping**: Regular user lists `/wallet_catalog` without `enabled == true` filter -> Denied by `resource.data.enabled == true`.
8. **ID Poisoning / Denial-of-Wallet**: Document ID of 500 characters or invalid symbols `../hack` -> Denied by `isValidId()`.
9. **Client Timestamp Forgery**: Creating a wallet, session, or audit log with `createdAt: "2020-01-01T00:00:00Z"` instead of server timestamp -> Denied by `incoming().createdAt == request.time`.
10. **Audit Log Deletion / Tampering**: Admin or user attempts `DELETE /admin_audit_logs/{id}` or `UPDATE` -> Denied (`allow update, delete: if false`).
11. **PII Blanket List Scraping**: Regular user runs `list` on `/users` or `/users/{otherUid}/private` -> Denied (`allow list: if isAdmin()`).
12. **Immutable Owner Mutation**: User attempts `UPDATE /users/{uid}/wallets/{wid}` or `connected_sessions/{sid}` changing `ownerUid` or `createdAt` -> Denied by immutability checks.
