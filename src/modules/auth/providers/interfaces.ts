/**
 * AUTHENTICATION PROVIDER SYSTEM
 *
 * Strategy Pattern for extensible auth methods:
 * - Email/Password
 * - SMS OTP
 * - OAuth (Google, Apple, GitHub)
 * - Custom providers (easily added)
 *
 * Each provider implements the AuthProvider interface
 * and can be plugged into the auth system
 */

export enum AuthMethod {
  EMAIL_PASSWORD = 'email_password',
  SMS_OTP = 'sms_otp',
  GOOGLE_OAUTH = 'google_oauth',
  APPLE_OAUTH = 'apple_oauth',
  GITHUB_OAUTH = 'github_oauth',
  ANONYMOUS = 'anonymous',
}

// ============================================
// PROVIDER INPUT / OUTPUT TYPES
// ============================================

export interface AuthInput {
  // Common fields
  app_id: string;
  ip_address: string;
  user_agent: string;
  device_id?: string;

  // Email/Password
  email?: string;
  password?: string;

  // SMS OTP
  phone_number?: string;
  otp?: string;

  // OAuth
  code?: string;
  redirect_uri?: string;
  id_token?: string;

  // Metadata
  metadata?: Record<string, any>;
}

export interface AuthenticateResult {
  user_id: string;
  email?: string;
  phone?: string;
  name?: string;
  avatar_url?: string;
  identity_id: string;
  is_new_user: boolean;
  provider: AuthMethod;
  provider_metadata?: Record<string, any>;
}

export interface VerificationResult {
  verified: boolean;
  message?: string;
  error?: string;
}

export interface RefreshResult {
  valid: boolean;
  message?: string;
}

// ============================================
// PROVIDER INTERFACE
// ============================================

export interface IAuthProvider {
  name: string;

  /**
   * Check if this provider supports the given auth method
   */
  supports(method: AuthMethod): boolean;

  /**
   * Authenticate user with provided credentials
   * Returns user data if successful, throws error if failed
   */
  authenticate(input: AuthInput): Promise<AuthenticateResult>;

  /**
   * Verify a token/code from the provider
   * Used for email verification tokens, OTP codes, etc.
   */
  verify?(token: string): Promise<VerificationResult>;

  /**
   * Refresh provider-specific tokens (e.g., OAuth refresh tokens)
   */
  refresh?(token: string): Promise<RefreshResult>;

  /**
   * Called after successful authentication
   * Perform any cleanup (e.g., remove OTP from DB)
   */
  cleanup?(input: AuthInput): Promise<void>;
}

// ============================================
// PROVIDER REGISTRY
// ============================================

/**
 * Central registry for auth providers
 * New providers can be added at runtime
 */
export class ProvidersRegistry {
  private providers: Map<AuthMethod, IAuthProvider> = new Map();

  /**
   * Register a new provider
   */
  register(method: AuthMethod, provider: IAuthProvider): void {
    if (this.providers.has(method)) {
      throw new Error(`Provider for ${method} already registered`);
    }
    this.providers.set(method, provider);
  }

  /**
   * Get provider for auth method
   */
  getProvider(method: AuthMethod): IAuthProvider {
    const provider = this.providers.get(method);
    if (!provider) {
      throw new Error(`Provider for ${method} not found`);
    }
    return provider;
  }

  /**
   * Check if provider exists
   */
  hasProvider(method: AuthMethod): boolean {
    return this.providers.has(method);
  }

  /**
   * Get all registered providers
   */
  getAllProviders(): Map<AuthMethod, IAuthProvider> {
    return new Map(this.providers);
  }
}

// ============================================
// COMMON PROVIDER ERRORS
// ============================================

export class AuthProviderError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode: number = 401
  ) {
    super(message);
    this.name = 'AuthProviderError';
  }
}

export class InvalidCredentialsError extends AuthProviderError {
  constructor(message: string = 'Invalid credentials') {
    super(message, 'INVALID_CREDENTIALS', 401);
  }
}

export class AccountNotFoundError extends AuthProviderError {
  constructor(message: string = 'Account not found') {
    super(message, 'ACCOUNT_NOT_FOUND', 404);
  }
}

export class AccountLockedError extends AuthProviderError {
  constructor(message: string = 'Account locked due to too many failed attempts') {
    super(message, 'ACCOUNT_LOCKED', 403);
  }
}

export class RateLimitError extends AuthProviderError {
  constructor(message: string = 'Too many attempts, please try again later') {
    super(message, 'RATE_LIMIT_EXCEEDED', 429);
  }
}

export class OtpExpiredError extends AuthProviderError {
  constructor(message: string = 'OTP has expired') {
    super(message, 'OTP_EXPIRED', 410);
  }
}

export class ProviderIntegrationError extends AuthProviderError {
  constructor(message: string = 'Provider integration error') {
    super(message, 'PROVIDER_ERROR', 500);
  }
}
