# Production-Grade Authentication Platform

## 1. HIGH-LEVEL ARCHITECTURE (Production + Scalable)

### Services Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     API Gateway / LB                         │
└────────────────────────┬────────────────────────────────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
   ┌────▼─────┐   ┌─────▼────┐   ┌─────▼────┐
   │  Auth     │   │ User     │   │ Session  │
   │  Service  │   │ Service  │   │ Service  │
   └────┬─────┘   └─────┬────┘   └─────┬────┘
        │                │              │
        └────────────────┼──────────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
   ┌────▼──────┐   ┌─────▼────┐   ┌─────▼──────┐
   │ PostgreSQL │   │ Redis    │   │ Providers  │
   │ (Primary)  │   │ (Cache)  │   │ (Pluggable)│
   └────────────┘   └──────────┘   └────────────┘
```

### Core Service Responsibilities

1. **Auth API (Stateless)**
   - Request routing
   - Provider coordination
   - Rate limiting
   - Request/response validation
   - Horizontally scalable

2. **Token Service**
   - JWT generation/validation
   - Refresh token lifecycle
   - Token rotation management
   - Claims management

3. **Session Service**
   - Device tracking
   - Session lifecycle
   - Multi-device logout
   - Session analytics

4. **Provider Adapters**
   - Email/Password
   - SMS OTP (Twilio)
   - OAuth (Google, Apple)
   - Strategy pattern for extensibility

### Redis + PostgreSQL Separation

- **Redis**: Cache, sessions, OTP codes, rate limiting state, temporary tokens
- **PostgreSQL**: Permanent data, identities, audit logs, refresh token hashes

### Event System Integration (Future)

```
Auth Events → Event Bus → RabbitMQ/Kafka
                          ↓
                    - Webhooks
                    - Analytics
                    - Anomaly Detection
                    - User Provisioning
```

---

## 2. AUTHENTICATION PROVIDER SYSTEM (Strategy Pattern)

### Provider Interface

Each provider implements this contract:

```typescript
interface AuthProvider {
  name: string;
  supports(method: AuthMethod): boolean;
  authenticate(input: AuthInput): Promise<ProviderResult>;
  verify(token: string): Promise<VerificationResult>;
  refresh?(token: string): Promise<RefreshResult>;
}
```

### Provider Types

1. **Email/Password Provider**
   - Argon2 hashing
   - Login with email + password
   - Account creation
   - Password reset flow

2. **SMS OTP Provider**
   - Twilio integration
   - 6-digit OTP generation
   - 5-minute expiration
   - Retry limits (3 attempts)
   - Rate limiting per phone

3. **OAuth Provider (Google, Apple)**
   - Code exchange flow
   - Identity verification
   - Automatic account creation
   - Linking existing accounts

4. **Native Apple Sign-In** (iOS)
   - ASAuthorizationAppleIDProvider
   - JWT verification
   - Cross-platform linking

### Adding a New Provider

1. Implement `AuthProvider` interface
2. Register in `ProvidersModule`
3. Add factory method
4. Update routing/guards
5. Add tests

---

## 3. DATABASE SCHEMA (Production-Level)

### Primary Entities

#### Users
- Single record per user (identity)
- Profile information (name, avatar, etc.)
- Account status (active, suspended, deleted)
- Created/updated timestamps

#### Apps (Tenants)
- Multi-tenant support
- API credentials
- Configuration per app
- Webhook URLs

#### Identities
- CRITICAL: Supports multiple login methods per user
- Each identity = one login method (email, phone, or social ID)
- Links to users via user_id
- Allows account linking

#### Sessions
- Device tracking
- Refresh tokens (hashed)
- Session metadata (IP, user agent)
- Expiration handling

#### Roles & Permissions
- App-scoped roles
- Fine-grained permissions
- User-role mapping

#### Audit Logs
- All auth events
- Failed attempts
- Provider usage
- IP/device tracking

---

## 4. AUTHENTICATION & SESSION LIFECYCLE

### Email/Password Login Flow

```
1. User: POST /v1/auth/login
   Body: { email, password }

2. Server:
   - Identify identity by email
   - Load user via identity
   - Verify password (Argon2)
   - Check MFA (if enabled)
   - Generate JWT + refresh token
   - Create session
   - Audit log

3. Response:
   {
     access_token: JWT,
     refresh_token: hashed_token,
     expires_in: 3600,
     device_id: UUID
   }

4. Client:
   - Store tokens securely
   - Set up auto-refresh
   - Include JWT in auth header
```

### SMS OTP Login Flow

```
1. User: POST /v1/auth/login/sms
   Body: { phone_number }

2. Server:
   - Validate phone format
   - Generate 6-digit OTP
   - Store in Redis (5 min expiry)
   - Rate limit: 3 requests/15 min
   - Send via Twilio
   - Audit log

3. User: POST /v1/auth/verify-sms
   Body: { phone_number, otp }

4. Server:
   - Retrieve OTP from Redis
   - Verify against input
   - Check expiration
   - Check attempt count
   - Find/create user
   - Generate JWT + refresh token
   - Create session
   - Cleanup Redis
```

### Refresh Token Rotation

```
Current: access_token + refresh_token
Refresh: POST /v1/auth/refresh
  Input: { refresh_token }
  
Server:
1. Hash incoming refresh token
2. Look up in database
3. Verify not expired/revoked
4. Issue NEW refresh token (rotation)
5. Invalidate old token
6. Return new access_token + refresh_token
7. Audit log

Security: Prevents refresh token reuse attacks
```

### Logout Strategies

```
Single Logout: DELETE /v1/auth/logout
  - Invalidate current session
  - Mark refresh token revoked
  
Global Logout: DELETE /v1/me/sessions
  - Invalidate ALL sessions
  - Revoke all refresh tokens
  - Clear Redis cache
```

### Identity Linking

```
User has: email + apple_id

POST /v1/me/identities/link
Body: {
  identity_type: "apple",
  verification_token: signed_apple_jwt
}

Server:
1. Verify token validity
2. Check if identity already linked
3. Add new identity record
4. Audit log
5. Return success

Now: One user account, multiple login paths
```

---

## 5. SECURITY DESIGN (DEEP)

### Password Hashing

```typescript
// Argon2 Configuration
const argon2 = argon2id {
  time_cost: 3,
  memory_cost: 65536 (64 MB),
  parallelism: 4,
  hash_length: 32,
}

// Prevents: Rainbow tables, GPU attacks, cracking
```

### OTP Security

```
- 6-digit OTP: ~1 million possibilities
- 5-minute expiration
- Max 3 attempts before lockout (15 min)
- Rate limiting: 3 requests per 15 minutes per phone
- SMS cannot be reliably considered "sent"
- Should ask user to confirm receipt
```

### Rate Limiting (Redis-based)

```
Per IP:
  - 10 login attempts / 15 minutes
  - 5 register attempts / per hour
  
Per User:
  - 3 failed password attempts / 5 min → lockout (15 min)
  - 5 OTP verification failures / 5 min → resend required
  
Per Phone:
  - 3 OTP requests / 15 minutes
```

### Brute-Force + Enumeration Protection

```
User Enumeration Prevention:
- "User not found" becomes "Invalid credentials"
- Same response time for existing/non-existing users
- Artificial delay on failed attempts

Brute-Force Protection:
- Account lockout after 5 failed attempts (15 min)
- Exponential backoff on retry
- IP-based rate limiting
- Device fingerprinting (suspicious logins)
```

### Secure Token Storage

```
Access Token: Sent in Authorization header
  - Short-lived (15 min)
  - No sensitive data in body
  - Can be passed in header (safer than localStorage)
  
Refresh Token: HTTPS-only cookie
  - Long-lived (7 days)
  - HttpOnly flag (prevents JS access)
  - Secure flag (HTTPS only)
  - SameSite=Strict (CSRF protection)
  - Hashed in database
  - Rotation on every use
```

### Email & Phone Verification

```
Email Verification:
1. Send link: https://app.com/verify?token=jwt
2. Token: Signed JWT (5 min expiry)
3. User clicks link
4. Verify signature
5. Mark email as verified

Phone Verification:
1. User provides phone
2. We send OTP
3. User enters OTP
4. Verify against Redis
5. Mark phone as verified
```

### Replay Attack Prevention

```
JWT Claims:
  {
    sub: user_id,
    app_id: tenant_id,
    device_id: UUID,
    iat: 1234567890,
    exp: 1234571490,
    jti: unique_token_id (prevents reuse)
  }

Validation:
  - Check expiration
  - Check device_id matches session
  - Check jti not in revocation list (Redis)
```

### CSRF/XSS Considerations (Web)

```
CSRF Prevention:
- POST requests require app_id in URL path
- SameSite=Strict on cookies
- Origin header validation

XSS Prevention:
- Tokens in Authorization header (not DOM accessible)
- CSP headers
- Escape all user input
- No tokens in localStorage (vulnerable to XSS)
```

### Common Auth Vulnerabilities & Mitigations

| Vulnerability | Mitigation |
|---|---|
| Weak password hashing | Argon2 with proper params |
| Brute force attacks | Rate limiting + account lockout |
| Session fixation | Rotate session ID on login |
| Stolen refresh tokens | Token rotation + device fingerprinting |
| User enumeration | Same response for valid/invalid users |
| CSRF attacks | SameSite cookies + origin validation |
| Replay attacks | JWT expiry + jti + device_id |
| Weak MFA | SMS recommended only for low-risk |
| Account takeover | 2FA + suspicious login detection |
| Sensitive data in JWT | Only app_id, user_id, roles |

---

## 6. API DESIGN (Clean + Versioned)

### POST /v1/auth/register
Register new user with email/password

```json
Request:
{
  "email": "user@example.com",
  "password": "SecurePassword123!",
  "name": "John Doe",
  "app_id": "app_uuid"
}

Response (201):
{
  "id": "user_uuid",
  "email": "user@example.com",
  "name": "John Doe",
  "created_at": "2024-03-27T10:00:00Z",
  "requires_email_verification": true
}

Errors:
- 400: Invalid email format
- 409: Email already exists
- 422: Weak password
```

### POST /v1/auth/login
Login with email/password

```json
Request:
{
  "email": "user@example.com",
  "password": "SecurePassword123!",
  "app_id": "app_uuid"
}

Response (200):
{
  "access_token": "eyJhbGc...",
  "refresh_token": "ref_xxx",
  "expires_in": 3600,
  "device_id": "device_uuid",
  "user": {
    "id": "user_uuid",
    "email": "user@example.com",
    "roles": ["user"]
  }
}

Errors:
- 401: Invalid credentials
- 429: Too many attempts
- 403: Account locked
```

### POST /v1/auth/login/sms
Request OTP via SMS

```json
Request:
{
  "phone_number": "+14155552671",
  "app_id": "app_uuid"
}

Response (200):
{
  "otp_request_id": "otp_req_uuid",
  "expires_in": 300,
  "delivery": "sms"
}

Errors:
- 400: Invalid phone format
- 429: Too many requests
```

### POST /v1/auth/verify-sms
Verify OTP

```json
Request:
{
  "phone_number": "+14155552671",
  "otp": "123456",
  "app_id": "app_uuid"
}

Response (200):
{
  "access_token": "eyJhbGc...",
  "refresh_token": "ref_xxx",
  "expires_in": 3600,
  "device_id": "device_uuid"
}

Errors:
- 401: Invalid OTP
- 410: OTP expired
- 429: Too many verification attempts
```

### POST /v1/auth/login/oauth
OAuth code exchange (Google, Apple)

```json
Request:
{
  "provider": "google",
  "code": "authorization_code",
  "redirect_uri": "https://app.com/auth/callback",
  "app_id": "app_uuid"
}

Response (200):
{
  "access_token": "eyJhbGc...",
  "refresh_token": "ref_xxx",
  "expires_in": 3600,
  "is_new_user": false
}

Errors:
- 400: Invalid code
- 401: OAuth provider error
```

### POST /v1/auth/refresh
Refresh access token

```json
Request:
{
  "refresh_token": "ref_xxx"
}

Response (200):
{
  "access_token": "eyJhbGc...",
  "refresh_token": "ref_yyy",
  "expires_in": 3600
}

Errors:
- 401: Invalid/expired refresh token
- 410: Token has been revoked
```

### POST /v1/auth/logout
Logout current session

```json
Request:
{
  "device_id": "device_uuid"
}

Response (200):
{
  "message": "Logged out successfully"
}
```

### POST /v1/auth/verify-email
Verify email with token

```json
Request:
{
  "token": "verification_jwt"
}

Response (200):
{
  "verified": true,
  "email": "user@example.com"
}

Errors:
- 400: Invalid/expired token
```

### GET /v1/me
Get current user

```json
Request:
Headers: { Authorization: "Bearer access_token" }

Response (200):
{
  "id": "user_uuid",
  "email": "user@example.com",
  "name": "John Doe",
  "phone_verified": true,
  "email_verified": true,
  "roles": ["user", "admin"],
  "app_id": "app_uuid",
  "updated_at": "2024-03-27T10:00:00Z"
}

Errors:
- 401: Missing/invalid token
```

---

## 7. MULTI-TENANT ARCHITECTURE

### Key Principle: Users belong to multiple apps

```
User (global)
  ├── Identity (email, phone, social)
  ├── App Membership 1 (Even)
  │   ├── Role: admin
  │   └── Permissions: [create_order, manage_users]
  └── App Membership 2 (TabUp)
      ├── Role: user
      └── Permissions: [view_orders]
```

### JWT Structure (includes tenant context)

```typescript
{
  sub: user_uuid,           // User ID
  app_id: app_uuid,         // Tenant ID
  app_roles: ["admin"],     // Roles in this app
  device_id: device_uuid,   // Device identifier
  iat: timestamp,
  exp: timestamp,
  jti: unique_id           // Token ID for revocation
}
```

### Tenant Isolation

```typescript
// All queries include app_id filter
SELECT * FROM users_apps
WHERE user_id = $1 AND app_id = $2;

// Cross-tenant prevention
if (req.user.app_id !== req.params.app_id) {
  throw new ForbiddenException();
}
```

### App-Scoped Roles

```
Each app has its own role hierarchy:

Even:
  - admin (create_orders, manage_users, export_data)
  - manager (create_orders, manage_users)
  - user (create_orders)

TabUp:
  - owner (all permissions)
  - staff (view_orders, update_orders)
  - viewer (view_orders)
```

---

## 8. RBAC + PERMISSIONS SYSTEM

### Role-Permission Model

```
Role (app_id, name)
├── permissions: [permission_id, ...]

Permission (app_id, name, resource, action)

User_App (user_id, app_id)
├── roles: [role_id, ...]
```

### Example Permission Set

```
Even App:
  - create:order
  - read:order
  - update:order
  - delete:order
  - manage:users
  - export:data

TabUp App:
  - read:order
  - update:order:status
  - view:reporting
```

### Guard Implementation

```typescript
// Extract roles from JWT claims
@UseGuards(JwtAuthGuard)
@UseGuards(RoleGuard(['admin']))
@Get()
getAdminPanel() {
  // Only accessible if user has admin role in app_id
}

// Permission-based guard
@UseGuards(PermissionGuard('create:order'))
@Post('orders')
createOrder() {
  // Only accessible if user has permission
}
```

---

## 9. DEVICE + SESSION MANAGEMENT

### Device Tracking

```
Session (user_id, app_id)
├── device_id: UUID
├── device_name: "iPhone 14 Pro"
├── device_type: "mobile"
├── user_agent: "..."
├── ip_address: "203.0.113.0"
├── location: { lat, lng, country }
├── last_active: 2024-03-27T10:00:00Z
├── created_at: 2024-03-20T10:00:00Z
├── expires_at: 2024-03-30T10:00:00Z
└── is_active: true
```

### Revoke Session

```
DELETE /v1/me/sessions/:device_id

Server:
1. Mark session as inactive
2. Revoke refresh token
3. Clear Redis cache
4. Audit log

Client:
- Remove local tokens
- Redirect to login
```

### Logout All Devices

```
DELETE /v1/me/sessions

Server:
1. Invalidate ALL sessions for user
2. Revoke ALL refresh tokens
3. Clear all Redis caches
4. Audit log

Use case: Password changed, suspicious activity
```

### Session Expiration Strategy

```
Access Token: 15 minutes
Refresh Token: 7 days
Session: 30 days of inactivity

If session inactive > 30 days:
  - Mark expired
  - User must login again

Logic:
  - Update last_active on each request
  - Check expiration on token refresh
  - Background job: cleanup expired sessions
```

---

## 10. OBSERVABILITY + AUDIT LOGS

### Logins Tracking

```
audit_logs table:
{
  id: UUID,
  user_id: user_uuid,
  app_id: app_uuid,
  event_type: "login" | "login_failed" | "logout",
  provider: "email" | "sms" | "google" | "apple",
  ip_address: "203.0.113.0",
  user_agent: "Mozilla/5.0...",
  device_id: device_uuid,
  location: { country, city, lat, lng },
  status: "success" | "failed",
  failure_reason: "invalid_password" | "account_locked",
  timestamp: 2024-03-27T10:00:00Z
}
```

### Failed Attempts Tracking

```
failed_attempts table:
{
  id: UUID,
  identity_id: identity_uuid,  // Email or phone
  attempt_timestamp: timestamp,
  ip_address: "203.0.113.0",
  attempt_count: 5,
  locked_until: timestamp
}

Used for:
- Brute force detection
- Account lockout logic
- Suspicious activity alerts
```

### Provider Usage Metrics

```
SELECT 
  provider,
  COUNT(*) as login_count,
  EXTRACT(date FROM timestamp) as date
FROM audit_logs
WHERE event_type = 'login' AND status = 'success'
GROUP BY provider, date;

Insights:
- Which auth methods are most used
- Adoption trends
- Regional preferences
```

### Metrics Dashboard

```
Key Metrics:
- Login success rate: 96%
- Average login time: 2.3s
- SMS OTP success: 92%
- OAuth conversion: 68%
- Most common provider: Google (45%)
- Failed login rate: 4%
- Account lockouts: 0.1%
```

### Suspicious Activity Detection

```
Rules:
1. New device login from far location (IP geolocation jump)
2. Multiple failed attempts from same IP
3. Login from multiple countries within 30 min
4. Unusual time of day login
5. New device from unusual location

Actions:
- Flag for review
- Send user email notification
- Request re-verification
- Optional: Require MFA
```

### Log Storage & Querying

```
Immediate (hot): Last 7 days in PostgreSQL
  - Fast queries
  - User notifications

Archive (cold): Older logs in S3
  - Cost-effective
  - Compliance (audit requirements)
  - Analytical queries

Querying:
SELECT * FROM audit_logs
WHERE app_id = $1 
  AND user_id = $2
  AND timestamp > now() - interval '30 days'
ORDER BY timestamp DESC;
```

---

## 11. INTEGRATION EXAMPLE (React Native)

### React Native Login Flow

```typescript
// Step 1: User initiates login
const login = async (email: string, password: string) => {
  try {
    const response = await fetch(
      'https://auth.api.com/v1/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ email, password, app_id }),
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    const data = await response.json();
    
    // Step 2: Store tokens securely
    await SecureStore.setItemAsync('access_token', data.access_token);
    await SecureStore.setItemAsync('refresh_token', data.refresh_token);
    
    // Step 3: Store device_id
    await SecureStore.setItemAsync('device_id', data.device_id);
    
  } catch (error) {
    console.error('Login failed:', error);
  }
};

// Step 4: Set up auto-refresh
useEffect(() => {
  const refreshInterval = setInterval(async () => {
    const refreshToken = await SecureStore.getItemAsync('refresh_token');
    
    const response = await fetch(
      'https://auth.api.com/v1/auth/refresh',
      {
        method: 'POST',
        body: JSON.stringify({ refresh_token }),
      }
    );
    
    const data = await response.json();
    await SecureStore.setItemAsync('access_token', data.access_token);
    await SecureStore.setItemAsync('refresh_token', data.refresh_token);
  }, 14 * 60 * 1000); // Refresh every 14 min
  
  return () => clearInterval(refreshInterval);
}, []);
```

### Backend Service Verifying JWT

```typescript
// Middleware: Extract and verify JWT
@UseGuards(JwtAuthGuard)
@Get('/orders')
getOrders(@Request() req) {
  const user = req.user; // {sub, app_id, roles, device_id}
  
  // Query orders for this user in this app
  return this.orderService.getOrdersForUser(user.sub, user.app_id);
}

// JwtAuthGuard:
// 1. Extract token from Authorization header
// 2. Verify signature (RS256 or HS256)
// 3. Check expiration
// 4. Check jti not revoked
// 5. Validate device_id matches session
// 6. Attach user to request
```

### Handling Refresh Automatically

```typescript
// Axios interceptor (or equivalent)
api.interceptors.response.use(
  response => response,
  async error => {
    const originalRequest = error.config;
    
    // If token expired (401)
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      
      const refreshToken = await SecureStore.getItemAsync('refresh_token');
      const response = await fetch(
        'https://auth.api.com/v1/auth/refresh',
        {
          method: 'POST',
          body: JSON.stringify({ refresh_token })
        }
      );
      
      const data = await response.json();
      await SecureStore.setItemAsync('access_token', data.access_token);
      
      // Retry original request with new token
      originalRequest.headers.Authorization = `Bearer ${data.access_token}`;
      return api(originalRequest);
    }
    
    return Promise.reject(error);
  }
);
```

---

## 12. 1–2 MONTH BUILD PLAN (WEEKLY)

### Week 1–2: Core Auth + DB Schema (Foundation)
- [x] Project setup (NestJS, PostgreSQL, Redis)
- [x] Database schema design
- [x] Entity definitions (User, Identity, App, etc.)
- [x] Database migrations
- [ ] Email/password provider implementation
- [ ] Argon2 password hashing
- [ ] Basic login/register endpoints
- [ ] JWT generation + validation
- [ ] Unit tests for core auth logic

**Deliverable**: Working email/password auth with login + register

### Week 3–4: Sessions + Refresh Tokens
- [ ] Session entity + repository
- [ ] Refresh token lifecycle (generation, rotation, revocation)
- [ ] Session management endpoints
- [ ] Auto-cleanup of expired sessions
- [ ] Device tracking
- [ ] Multi-device logout
- [ ] Rate limiting setup (Redis)
- [ ] Audit logging for auth events

**Deliverable**: JWT + refresh tokens with proper rotation, session management

### Week 5–6: SMS OTP + OAuth (Providers)
- [ ] SMS OTP provider (Twilio integration)
- [ ] OTP generation + verification
- [ ] OAuth provider base classes
- [ ] Google OAuth implementation
- [ ] Apple Sign-In implementation
- [ ] Identity linking logic
- [ ] Account creation from OAuth

**Deliverable**: Multiple auth methods (SMS, Google, Apple) with account linking

### Week 7–8: RBAC + Multi-Tenant (Advanced)
- [ ] Role + Permission entities
- [ ] User_App membership
- [ ] Role/permission guards
- [ ] Multi-tenant isolation validation
- [ ] Admin dashboard (basic)
- [ ] Security hardening review
- [ ] Audit log querying + reporting
- [ ] Load testing + performance optimization

**Deliverable**: Production-ready multi-tenant auth platform

### Week 9–10: Observability + Advanced Features
- [ ] Detailed audit logging
- [ ] Anomaly detection rules
- [ ] Email notifications on suspicious login
- [ ] Administrative controls (user suspend, reset password)
- [ ] Session analytics
- [ ] Failed attempt tracking + lockout logic
- [ ] Documentation + deployment guide

**Deliverable**: Fully observable, production-grade auth system

---

## 13. ADVANCED ADD-ONS (if time allows)

### SSO Across Apps

```typescript
// User logs into App A
// Automatically signed into App B (same account)

POST /v1/auth/sso/request
Body: { app_from_id, app_to_id }

Response:
{
  sso_token: signed_jwt,  // 30 sec expiry
  redirect_url: "https://appb.com/auth/sso/callback?token=xxx"
}

AppB verifies token signature, auto-creates session
```

### Admin Dashboard

```
Features:
- List all users
- View user's identities + sessions
- Suspend/unsuspend account
- Reset password (admin initiated)
- View audit logs
- Download compliance reports
- Configure app settings
```

### Anomaly Detection

```
ML-based or rule-based:
- Unusual IP location
- New device
- Login at unusual time
- Multiple failed attempts from same IP
- Impossible travel (NYC → London in 5 min)

Actions:
- Flag for review
- Email user
- Request additional verification
- Require MFA on next login
```

### Event Streaming Integration

```
Auth Events → RabbitMQ/Kafka → Tools

Events:
- user.registered
- user.login_success
- user.login_failed
- user.identity_linked
- user.session_revoked
- user.account_suspended

Consumers:
- Webhook delivery system
- Analytics pipeline
- Notification service
- Fraud detection ML
- User provisioning systems
```

---

## Architecture Trade-offs & Alternatives

### JWT vs SessionID
- **JWT**: Stateless, scalable, no server-side lookup
- **SessionID**: Centralized control, easy revocation
- **Choice**: JWT with optional Redis revocation list

### Refresh Token Storage
- **HttpOnly Cookie**: CSRF vulnerability, but JS-safe
- **LocalStorage**: Vulnerable to XSS
- **SecureStore (Mobile)**: Most secure
- **Choice**: HttpOnly + Secure + SameSite for web, SecureStore for mobile

### OTP via SMS vs Email
- **SMS**: Faster, out-of-band
- **Email**: More accessible, no cost
- **Choice**: Support both, user preference

### Argon2 Variants
- **Argon2i**: Against GPU attacks
- **Argon2d**: Against side-channel attacks
- **Argon2id**: Hybrid
- **Choice**: Argon2id (balanced security)

---

## Key Metrics & SLOs

```
Availability: 99.95% uptime
Authentication latency: P99 < 500ms
Token generation: P99 < 100ms
Login success rate: > 98%
OAuth success rate: > 95%
SMS delivery rate: > 98%
```

