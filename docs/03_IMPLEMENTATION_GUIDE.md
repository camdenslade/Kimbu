# IMPLEMENTATION GUIDE
# Production Auth Platform

## Quick Start

### 1. Prerequisites
```bash
# Required
- Node.js 18+
- npm or pnpm
- PostgreSQL 13+
- Redis 6+ (optional but recommended)

# Optional
- Docker & Docker Compose
```

### 2. Setup Development Environment
```bash
# Install dependencies
pnpm install

# Copy environment template
cp .env.example .env.local

# Configure your environment
# Edit .env.local with:
# - DB credentials
# - Redis connection
# - JWT secret (generate: openssl rand -base64 32)
# - OAuth client IDs/secrets
```

### 3. Database Setup
```bash
# Create PostgreSQL database
createdb auth_db

# Run migrations
pnpm migration:generate
pnpm migration:run

# Seed initial data (optional)
pnpm seed
```

### 4. Start Development Server
```bash
pnpm start:dev

# Server should be running on http://localhost:3001
# Health check: curl http://localhost:3001/health
```

---

## Core Concepts

### Authentication Flow
```
User Registration:
1. User provides email + password
2. System validates input
3. Hash password with Argon2
4. Create User entity
5. Create Identity (email type)
6. Return user_id

User Login:
1. User provides email + password
2. System finds Identity (email match)
3. Verify password (Argon2 comparison)
4. Generate JWT (15 min expiry)
5. Generate Refresh Token (7 day expiry)
6. Store refresh token hash in Session
7. Return tokens + device_id

Token Refresh:
1. Client sends refresh_token
2. System hashes token
3. Look up Session in database
4. Verify token not expired/revoked
5. Generate NEW refresh token (rotation)
6. Update Session with new hash
7. Return new access_token + refresh_token
```

### Multi-Tenancy
```
One User, Multiple Apps:
```
user_1
├── Even (app_1)
│   ├── roles: [admin, manager]
│   └── permissions: [create:order, manage:users]
└── TabUp (app_2)
    ├── roles: [user]
    └── permissions: [create:order]

JWT Payload:
{
  sub: user_1,
  app_id: app_1,      ← Tenant context
  roles: ["admin"],   ← App-scoped
  ...
}

Queries:
SELECT * FROM orders WHERE app_id = app_1
```

### RBAC Model
```
Role (per app):
├── name: "admin"
├── permissions: [
│   "create:order",
│   "read:order",
│   "delete:order",
│   "manage:users"
│ ]

User (per app):
├── roles: [admin_role_id]

Permission Check:
1. Extract roles from JWT
2. Load role_permissions from DB (cached)
3. Check if action allowed
4. If yes: proceed, If no: 403
```

---

## Key Files & Structure

```
src/
├── main.ts                          # Application entry point
├── app.module.ts                    # Root module
├── common/
│   ├── security.service.ts          # Argon2, OTP, hashing
│   └── token.service.ts             # JWT generation/validation
├── database/
│   ├── entities.ts                  # TypeORM entities
│   └── migrations/                  # Database migrations
├── modules/
│   ├── auth/
│   │   ├── providers/
│   │   │   ├── interfaces.ts        # Provider interface
│   │   │   ├── email-password.provider.ts  # Email/password
│   │   │   └── sms-otp.provider.ts        # SMS OTP
│   │   ├── services/
│   │   │   └── auth.service.ts      # Auth orchestration
│   │   └── auth.controller.ts       # API endpoints
│   └── users/
│       ├── users.service.ts
│       └── users.controller.ts
└── docs/
    ├── 01_ARCHITECTURE.md           # High-level design
    ├── 02_BUILD_PLAN.md             # Sprint planning
    └── 03_IMPLEMENTATION_GUIDE.md   # This file
```

---

## Common Tasks

### Adding a New Auth Provider

1. **Create Provider Class**
```typescript
// src/modules/auth/providers/github.provider.ts
import { IAuthProvider, AuthMethod, AuthInput, AuthenticateResult } from './interfaces';

@Injectable()
export class GitHubProvider implements IAuthProvider {
  name = 'github_oauth';

  supports(method: AuthMethod): boolean {
    return method === AuthMethod.GITHUB_OAUTH;
  }

  async authenticate(input: AuthInput): Promise<AuthenticateResult> {
    // 1. Exchange code for GitHub token
    // 2. Fetch user profile
    // 3. Find/create user
    // 4. Return auth result
  }
}
```

2. **Register Provider**
```typescript
// src/modules/auth/auth.module.ts
providers: [
  EmailPasswordProvider,
  SmsOtpProvider,
  GitHubProvider,  // Add here
]
```

3. **Add to Enum**
```typescript
// src/modules/auth/providers/interfaces.ts
export enum AuthMethod {
  EMAIL_PASSWORD = 'email_password',
  SMS_OTP = 'sms_otp',
  GITHUB_OAUTH = 'github_oauth',  // Add here
}
```

4. **Add API Endpoint**
```typescript
// Route maps to provider
POST /v1/auth/login/oauth
Body: { provider: "github", code, redirect_uri }
```

---

### Adding a Permission

1. **Create Permission in DB**
```typescript
const permission = await permissionsRepository.save({
  app_id: app_id,
  name: 'download:reports',
  resource: 'reports',
  action: 'download',
});
```

2. **Add to Role**
```typescript
const role = await rolesRepository.findOne(...);
role.permissions = [...role.permissions, permission];
await rolesRepository.save(role);
```

3. **Enforce in Controller**
```typescript
@UseGuards(PermissionGuard('download:reports'))
@Get('/reports/export')
exportReports() { ... }
```

---

### Implement a New Auth Flow

**Example: Passwordless Email Magic Links**

1. **Create Provider**
```typescript
@Injectable()
export class MagicLinkProvider implements IAuthProvider {
  supports(method: AuthMethod): boolean {
    return method === AuthMethod.EMAIL_MAGIC_LINK;
  }

  async authenticate(input: AuthInput): Promise<AuthenticateResult> {
    // 1. Generate token
    // 2. Send email with link
    // 3. Return "check your email" response
  }

  async verify(token: string): Promise<VerificationResult> {
    // 1. Verify token signature
    // 2. Check expiration
    // 3. Complete authentication
  }
}
```

2. **Add API Endpoints**
```typescript
POST /v1/auth/login/email-magic-link
Body: { email }
Response: { message: "Check your email" }

GET /v1/auth/verify?token=jwt
Response: { access_token, refresh_token }
```

---

## Testing Strategy

### Unit Tests
```typescript
// Test password hashing
it('should hash password with Argon2', async () => {
  const password = 'SecurePassword123!';
  const hash = await securityService.hashPassword(password);
  const isValid = await securityService.verifyPassword(password, hash);
  expect(isValid).toBe(true);
});

// Test OTP generation
it('should generate unique 6-digit OTP', () => {
  const otp1 = securityService.generateOtp();
  const otp2 = securityService.generateOtp();
  expect(otp1).toMatch(/^\d{6}$/);
  expect(otp1).not.toEqual(otp2); // Usually
});
```

### Integration Tests
```typescript
// Test full login flow
it('should login user with email and password', async () => {
  // 1. Register user
  await authService.register('user@example.com', 'Password123!');
  
  // 2. Login
  const response = await authController.login({
    email: 'user@example.com',
    password: 'Password123!'
  });
  
  // 3. Verify response
  expect(response.access_token).toBeDefined();
  expect(response.refresh_token).toBeDefined();
});
```

### Load Testing
```bash
# With Apache Bench
ab -n 1000 -c 50 http://localhost:3001/health

# With k6
import http from 'k6/http';
import { check } from 'k6';

export default function() {
  const response = http.post('http://localhost:3001/v1/auth/login', {
    email: 'user@example.com',
    password: 'Password123!'
  });
  check(response, {
    'status is 200': (r) => r.status === 200,
  });
}
```

---

## Security Checklist

### Before Production

- [ ] **Secrets Management**
  - [ ] JWT secret: 32+ random bytes (not committed)
  - [ ] API keys: Stored in env variables
  - [ ] Database password: Strong (20+ chars)
  
- [ ] **Network Security**
  - [ ] HTTPS/TLS on all endpoints
  - [ ] CORS properly configured (not *)
  - [ ] Security headers (HSTS, CSP, X-Frame-Options)
  
- [ ] **Authentication Security**
  - [ ] Argon2 parameters correct
  - [ ] Password validation enforced
  - [ ] Rate limiting active
  - [ ] Brute-force protection enabled
  
- [ ] **Token Security**
  - [ ] Refresh tokens hashed in DB
  - [ ] HttpOnly + Secure + SameSite flags
  - [ ] Token rotation on refresh
  - [ ] Revocation list working
  
- [ ] **Data Security**
  - [ ] Sensitive data encrypted at rest
  - [ ] Database backups encrypted
  - [ ] Audit logs stored securely
  - [ ] No passwords in logs
  
- [ ] **Monitoring**
  - [ ] Failed login tracking
  - [ ] Anomaly detection rules
  - [ ] Error alerting configured
  - [ ] Performance monitoring active

---

## Performance Optimization

### Database Queries
```typescript
// ❌ Bad: N+1 query problem
for (const session of sessions) {
  const user = await usersRepository.findOne(session.user_id);
}

// ✅ Good: Batch load with relations
const sessions = await sessionsRepository.find({
  relations: ['user'],
});
```

### Caching Strategy
```typescript
// Cache roles/permissions (TTL: 1 hour)
const cacheKey = `roles:${app_id}:${user_id}`;
let roles = await cacheManager.get(cacheKey);

if (!roles) {
  roles = await rolesRepository.find({ where: { app_id } });
  await cacheManager.set(cacheKey, roles, 3600000);
}
```

### Rate Limiting
```typescript
// Per-user rate limiting (Redis)
const cacheKey = `ratelimit:login:${email}`;
const attempts = await cacheManager.get(cacheKey);

if (attempts >= 5) {
  throw new RateLimitError();
}
```

---

## Troubleshooting

### "Invalid refresh token"
- Likely causes:
  1. Token has been rotated (old token not accepted)
  2. Session has expired (> 7 days)
  3. Token has been explicitly revoked
  
- Fix:
  ```
  1. Check token expiry: decode JWT
  2. Check database for session
  3. Clear cache and retry
  4. If still fails: Re-authenticate
  ```

### "Too many failed attempts"
- Likely causes:
  1. Wrong password entered 3+ times
  2. Rate limit from IP exceeded
  
- Fix:
  ```
  1. Wait 15 minutes
  2. Try from different network (if testing)
  3. Reset password if locked out
  ```

### "Unauthorized: Invalid token"
- Likely causes:
  1. Token expired (> 15 minutes)
  2. Token has been revoked
  3. JWT signature validation failed
  
- Fix:
  1. Use refresh token to get new access token
  2. Check token format (must start with "Bearer ")
  3. Verify JWT secret matches

### Database Connection Errors
- Likely causes:
  1. PostgreSQL not running
  2. Wrong credentials in .env
  3. Database doesn't exist
  
- Fix:
  ```bash
  # Check PostgreSQL
  psql postgres -U postgres -c "\l"
  
  # Create database
  createdb auth_db
  
  # Run migrations
  pnpm migration:run
  ```

---

## Production Deployment

### Docker Setup
```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

EXPOSE 3001
CMD ["node", "dist/main"]
```

### Docker Compose
```yaml
version: '3.8'
services:
  auth-server:
    build: .
    ports:
      - "3001:3001"
    environment:
      - DB_HOST=postgres
      - REDIS_HOST=redis
    depends_on:
      - postgres
      - redis

  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: auth_db
      POSTGRES_PASSWORD: postgres
    volumes:
      - postgres_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data

volumes:
  postgres_data:
  redis_data:
```

### Deployment Commands
```bash
# Build
docker build -t auth-service:latest .

# Deploy to Heroku
heroku create auth-service
git push heroku main

# Deploy to AWS
aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
docker tag auth-service <account>.dkr.ecr.us-east-1.amazonaws.com/auth-service:latest
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/auth-service:latest
```

---

## Monitoring & Observability

### Key Metrics
```
1. Authentication Metrics:
   - Logins per minute
   - Success rate (%)
   - Failed attempts (%)
   - Provider breakdown

2. Performance:
   - API latency (p50, p99)
   - Database query time
   - Cache hit rate

3. Security:
   - Brute-force attempts
   - Suspicious logins
   - Failed 2FA attempts
   - Rate limit violations
```

### Logging
```typescript
// Structured logs for analysis
logger.info({
  event: 'user_login',
  user_id: userId,
  provider: 'email',
  ip_address: ipAddress,
  success: true,
  duration_ms: 234,
  timestamp: new Date(),
});
```

---

## Next Steps

1. **Setup Development**: Follow "Quick Start" above
2. **Implement Providers**: Add email/password, SMS OTP
3. **Build Controllers**: Create API endpoints
4. **Add Tests**: Unit + integration tests
5. **Deploy**: Use Docker for production

---

## Resources

- **NestJS Docs**: https://docs.nestjs.com/
- **TypeORM Docs**: https://typeorm.io/
- **Passport.js**: https://www.passportjs.org/
- **OWASP Auth Guide**: https://cheatsheetseries.owasp.org/
- **OAuth 2.0**: https://datatracker.ietf.org/doc/html/rfc6749
