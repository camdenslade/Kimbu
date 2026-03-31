# API REFERENCE
# Production Auth Platform

Base URL: `https://api.auth.example.com`
API Version: `v1`

## Authentication

All endpoints (except public ones) require:
```
Authorization: Bearer {access_token}
Content-Type: application/json
```

Public endpoints:
- `POST /v1/auth/register`
- `POST /v1/auth/login`
- `POST /v1/auth/login/sms`
- `POST /v1/auth/verify-sms`
- `POST /v1/auth/login/oauth`
- `POST /v1/auth/refresh`
- `POST /v1/auth/verify-email`

---

## Auth Endpoints

### POST /v1/auth/register
Register new user with email and password.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "SecurePassword123!",
  "name": "John Doe",
  "app_id": "app-uuid"
}
```

**Response (201):**
```json
{
  "id": "user-uuid",
  "email": "user@example.com",
  "name": "John Doe",
  "email_verified": false,
  "created_at": "2024-03-27T10:00:00Z",
  "requires_email_verification": true
}
```

**Errors:**
- `400 Bad Request`: Invalid email format, weak password
- `409 Conflict`: Email already registered
- `422 Unprocessable Entity`: Password requirements not met

---

### POST /v1/auth/login
Login with email and password.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "SecurePassword123!",
  "app_id": "app-uuid"
}
```

**Response (200):**
```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "ref_abc123def456...",
  "expires_in": 900,
  "device_id": "device-uuid",
  "user": {
    "id": "user-uuid",
    "email": "user@example.com",
    "name": "John Doe",
    "roles": ["user"]
  }
}
```

**Errors:**
- `401 Unauthorized`: Invalid credentials
- `403 Forbidden`: Account locked
- `429 Too Many Requests`: Rate limit exceeded

**Security Features:**
- Argon2 password verification
- Brute-force protection (max 5 attempts per 15 min)
- Account lockout (15 min after 5 failures)
- No user enumeration (same error for all failures)

---

### POST /v1/auth/login/sms
Request SMS OTP.

**Request:**
```json
{
  "phone_number": "+14155552671",
  "app_id": "app-uuid"
}
```

**Response (200):**
```json
{
  "otp_request_id": "otp-req-uuid",
  "expires_in": 300,
  "delivery": "sms"
}
```

**Errors:**
- `400 Bad Request`: Invalid phone format
- `429 Too Many Requests`: Max 3 OTP requests per 15 minutes

**Security Features:**
- Phone number normalized to E.164 format
- Rate limiting: 3 requests per phone per 15 minutes
- 5-minute OTP expiration
- Max 3 verification attempts

---

### POST /v1/auth/verify-sms
Verify SMS OTP and authenticate.

**Request:**
```json
{
  "phone_number": "+14155552671",
  "otp": "123456",
  "app_id": "app-uuid"
}
```

**Response (200):**
```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "ref_abc123def456...",
  "expires_in": 900,
  "device_id": "device-uuid",
  "is_new_user": false
}
```

**Errors:**
- `400 Bad Request`: Invalid OTP format
- `401 Unauthorized`: Invalid/incorrect OTP
- `404 Not Found`: No OTP found for phone
- `410 Gone`: OTP expired
- `429 Too Many Requests`: Max 3 verification attempts exceeded

---

### POST /v1/auth/login/oauth
OAuth provider code exchange.

**Request:**
```json
{
  "provider": "google",
  "code": "4/0AX4XfWg...",
  "redirect_uri": "https://app.example.com/auth/callback",
  "app_id": "app-uuid"
}
```

Supported providers: `google`, `apple`, `github` (if configured)

**Response (200):**
```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "ref_abc123def456...",
  "expires_in": 900,
  "device_id": "device-uuid",
  "is_new_user": true
}
```

**Errors:**
- `400 Bad Request`: Invalid code format
- `401 Unauthorized`: OAuth provider error
- `502 Bad Gateway`: Provider integration error

---

### POST /v1/auth/refresh
Refresh access token with refresh token.

**Request:**
```json
{
  "refresh_token": "ref_abc123def456..."
}
```

**Response (200):**
```json
{
  "access_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",
  "refresh_token": "ref_xyz789uvw012...",
  "expires_in": 900
}
```

**Errors:**
- `401 Unauthorized`: Invalid/expired refresh token
- `410 Gone`: Token has been revoked
- `429 Too Many Requests`: Token rotation rate limit

**Security Features:**
- Refresh token rotation (new token returned)
- Old token automatically invalidated
- Prevents refresh token reuse attacks
- Detects token theft (reuse triggers re-authentication)

---

### POST /v1/auth/logout
Logout current session.

**Request:**
```json
{
  "device_id": "device-uuid"
}
```

**Response (200):**
```json
{
  "message": "Logged out successfully"
}
```

---

### POST /v1/auth/verify-email
Verify email with token.

**Request:**
```json
{
  "token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response (200):**
```json
{
  "verified": true,
  "email": "user@example.com"
}
```

**Errors:**
- `400 Bad Request`: Invalid/malformed token
- `401 Unauthorized`: Invalid signature
- `410 Gone`: Token has expired

---

## User Endpoints

### GET /v1/me
Get current user profile.

**Headers:**
```
Authorization: Bearer {access_token}
```

**Response (200):**
```json
{
  "id": "user-uuid",
  "email": "user@example.com",
  "phone": "+14155552671",
  "name": "John Doe",
  "avatar_url": "https://example.com/avatar.jpg",
  "email_verified": true,
  "phone_verified": true,
  "roles": ["user", "admin"],
  "app_id": "app-uuid",
  "created_at": "2024-03-27T10:00:00Z",
  "updated_at": "2024-03-27T10:00:00Z"
}
```

**Errors:**
- `401 Unauthorized`: Missing/invalid token

---

### PATCH /v1/me
Update user profile.

**Request:**
```json
{
  "name": "Jane Doe",
  "avatar_url": "https://example.com/new-avatar.jpg"
}
```

**Response (200):**
```json
{
  "id": "user-uuid",
  "name": "Jane Doe",
  "avatar_url": "https://example.com/new-avatar.jpg",
  "updated_at": "2024-03-27T11:00:00Z"
}
```

---

### GET /v1/me/identities
Get all linked identities.

**Response (200):**
```json
[
  {
    "id": "identity-uuid-1",
    "identity_type": "email",
    "email": "user@example.com",
    "is_primary": true,
    "is_verified": true
  },
  {
    "id": "identity-uuid-2",
    "identity_type": "phone",
    "phone": "+14155552671",
    "is_primary": false,
    "is_verified": true
  },
  {
    "id": "identity-uuid-3",
    "identity_type": "google",
    "provider_id": "118456789...",
    "is_verified": true
  }
]
```

---

### POST /v1/me/identities/link
Link new authentication method.

**Request:**
```json
{
  "identity_type": "apple",
  "verification_token": "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Response (201):**
```json
{
  "id": "identity-uuid",
  "identity_type": "apple",
  "provider_id": "001234.56789abcdef...",
  "is_verified": true
}
```

---

### POST /v1/me/identities/:identity_id/unlink
Unlink authentication method.

**Request:**
```json
{
  "reason": "No longer using this method"
}
```

**Response (200):**
```json
{
  "message": "Identity unlinked successfully"
}
```

**Errors:**
- `400 Bad Request`: Cannot unlink last identity

---

## Session Management

### GET /v1/me/sessions
Get all active sessions.

**Response (200):**
```json
[
  {
    "id": "session-uuid-1",
    "device_id": "device-1",
    "device_name": "iPhone 14 Pro",
    "device_type": "mobile",
    "ip_address": "203.0.113.0",
    "user_agent": "Mozilla/5.0...",
    "last_active_at": "2024-03-27T10:15:00Z",
    "created_at": "2024-03-27T10:00:00Z",
    "expires_at": "2024-04-03T10:00:00Z"
  }
]
```

---

### DELETE /v1/me/sessions/:device_id
Revoke specific session.

**Response (200):**
```json
{
  "message": "Session revoked"
}
```

---

### DELETE /v1/me/sessions
Logout from all devices (global logout).

**Response (200):**
```json
{
  "message": "Logged out from all devices"
}
```

---

## Audit & Security

### GET /v1/me/audit-logs
Get user's login history.

**Query Parameters:**
- `days` (optional): Number of days to look back (default: 30)
- `limit` (optional): Number of records (default: 50, max: 1000)
- `offset` (optional): Pagination offset (default: 0)

**Response (200):**
```json
{
  "total": 125,
  "data": [
    {
      "id": "log-uuid",
      "event_type": "login",
      "provider": "email",
      "status": "success",
      "ip_address": "203.0.113.0",
      "user_agent": "Mozilla/5.0...",
      "device_id": "device-1",
      "timestamp": "2024-03-27T10:00:00Z"
    },
    {
      "id": "log-uuid-2",
      "event_type": "login_failed",
      "provider": "email",
      "status": "failed",
      "failure_reason": "invalid_password",
      "ip_address": "192.0.2.1",
      "timestamp": "2024-03-26T15:30:00Z"
    }
  ]
}
```

---

## Error Handling

All errors follow standard format:

```json
{
  "statusCode": 401,
  "message": "Invalid credentials",
  "error": "INVALID_CREDENTIALS",
  "timestamp": "2024-03-27T10:00:00Z",
  "path": "/v1/auth/login"
}
```

### Common Error Codes

| Code | Status | Meaning |
|------|--------|---------|
| `INVALID_CREDENTIALS` | 401 | Email/password incorrect |
| `ACCOUNT_NOT_FOUND` | 404 | User doesn't exist |
| `ACCOUNT_LOCKED` | 403 | Too many failed attempts |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests |
| `INVALID_TOKEN` | 401 | Token invalid/expired |
| `EMAIL_EXISTS` | 409 | Email already registered |
| `WEAK_PASSWORD` | 422 | Password doesn't meet requirements |
| `OTP_EXPIRED` | 410 | OTP code has expired |
| `UNAUTHORIZED` | 401 | No authentication provided |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `INTERNAL_SERVER_ERROR` | 500 | Server error |

---

## Rate Limiting

Endpoints are rate-limited based on IP address and user:

```
Headers in Response:
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 42
X-RateLimit-Reset: 1711515600
```

Limits by endpoint:
- Login: 10 attempts per 15 minutes per IP
- Register: 5 attempts per hour per IP
- SMS OTP request: 3 per 15 minutes per phone
- SMS OTP verify: 3 attempts per OTP

---

## Webhook Events (Future)

Webhooks for auth events:

```json
{
  "event": "user.login",
  "timestamp": "2024-03-27T10:00:00Z",
  "data": {
    "user_id": "user-uuid",
    "provider": "email",
    "app_id": "app-uuid",
    "ip_address": "203.0.113.0",
    "device_id": "device-uuid"
  }
}
```

Webhook events:
- `user.registered`
- `user.login_success`
- `user.login_failed`
- `user.logout`
- `user.identity_linked`
- `user.session_revoked`
- `user.password_changed`
- `user.account_suspended`

---

## Code Examples

### JavaScript/TypeScript
```typescript
// Login
const response = await fetch('https://api.auth.example.com/v1/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: 'user@example.com',
    password: 'SecurePassword123!',
    app_id: 'app-uuid'
  })
});

const { access_token, refresh_token } = await response.json();

// Authenticated request
const userResponse = await fetch('https://api.auth.example.com/v1/me', {
  headers: { 'Authorization': `Bearer ${access_token}` }
});

const user = await userResponse.json();
```

### Python
```python
import requests

# Login
response = requests.post(
  'https://api.auth.example.com/v1/auth/login',
  json={
    'email': 'user@example.com',
    'password': 'SecurePassword123!',
    'app_id': 'app-uuid'
  }
)

data = response.json()
access_token = data['access_token']

# Authenticated request
user_response = requests.get(
  'https://api.auth.example.com/v1/me',
  headers={'Authorization': f'Bearer {access_token}'}
)

user = user_response.json()
```

### cURL
```bash
# Login
curl -X POST https://api.auth.example.com/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "SecurePassword123!",
    "app_id": "app-uuid"
  }'

# Get user
curl -X GET https://api.auth.example.com/v1/me \
  -H "Authorization: Bearer <access_token>"
```

---

## Testing

### Generate Test Tokens

```bash
# Quick login for testing
curl -X POST http://localhost:3001/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "TestPassword123!",
    "app_id": "00000000-0000-0000-0000-000000000000"
  }'
```

### Test Rate Limiting

```bash
# Trigger rate limit (10 login attempts)
for i in {1..15}; do
  curl -X POST http://localhost:3001/v1/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email": "test@example.com", "password": "wrong"}'
  sleep 0.5
done

# Should get 429 after 10 attempts
```
