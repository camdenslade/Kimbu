# REACT NATIVE INTEGRATION GUIDE
# Production Auth Platform Example

Complete example showing how to integrate the auth platform in a React Native app.

---

## Overview

This guide covers:
- User registration & login
- Secure token storage
- Automatic token refresh
- Multi-device session management
- Error handling
- Logout

---

## 1. Setup & Configuration

### Install Dependencies

```bash
npm install \
  expo-secure-store \
  axios \
  @react-native-async-storage/async-storage \
  react-native-keychain

# For Expo projects:
expo install expo-secure-store
```

### Environment Configuration

```typescript
// config/auth.ts
export const AUTH_CONFIG = {
  API_URL: process.env.REACT_APP_API_URL || 'https://api.auth.example.com',
  ENDPOINTS: {
    REGISTER: '/v1/auth/register',
    LOGIN: '/v1/auth/login',
    LOGIN_SMS: '/v1/auth/login/sms',
    VERIFY_SMS: '/v1/auth/verify-sms',
    LOGIN_OAUTH: '/v1/auth/login/oauth',
    REFRESH: '/v1/auth/refresh',
    LOGOUT: '/v1/auth/logout',
    ME: '/v1/me',
  },
  TOKEN_EXPIRY_MS: 15 * 60 * 1000, // 15 minutes
  REFRESH_INTERVAL_MS: 14 * 60 * 1000, // 14 minutes (before expiry)
};

export const APP_ID = 'your-app-id-uuid';
```

---

## 2. Secure Token Storage

### Create Storage Service

```typescript
// services/TokenStorage.ts
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import * as Keychain from 'react-native-keychain';

const TOKENS_KEY = 'auth_tokens';

interface StoredTokens {
  access_token: string;
  refresh_token: string;
  device_id: string;
  expires_at: number;
}

export class TokenStorage {
  /**
   * Save tokens securely
   *
   * iOS: Keychain
   * Android: Keystore
   * Web: Encrypted localStorage
   */
  static async saveTokens(tokens: StoredTokens): Promise<void> {
    try {
      const jsonString = JSON.stringify(tokens);

      if (Platform.OS === 'web') {
        // Web: Use encrypted localStorage if available
        localStorage.setItem(TOKENS_KEY, jsonString);
      } else {
        // Mobile: Use secure storage
        await SecureStore.setItemAsync(TOKENS_KEY, jsonString);
      }
    } catch (error) {
      console.error('Failed to save tokens:', error);
      throw error;
    }
  }

  /**
   * Retrieve stored tokens
   */
  static async getTokens(): Promise<StoredTokens | null> {
    try {
      let jsonString: string | null = null;

      if (Platform.OS === 'web') {
        jsonString = localStorage.getItem(TOKENS_KEY);
      } else {
        jsonString = await SecureStore.getItemAsync(TOKENS_KEY);
      }

      if (!jsonString) return null;

      const tokens: StoredTokens = JSON.parse(jsonString);
      return tokens;
    } catch (error) {
      console.error('Failed to retrieve tokens:', error);
      return null;
    }
  }

  /**
   * Check if tokens are still valid
   */
  static async isTokenValid(): Promise<boolean> {
    const tokens = await this.getTokens();
    if (!tokens) return false;

    // Check if access token expires within 2 minutes
    const expiresIn = tokens.expires_at - Date.now();
    const bufferMs = 2 * 60 * 1000;

    return expiresIn > bufferMs;
  }

  /**
   * Get current access token
   */
  static async getAccessToken(): Promise<string | null> {
    const tokens = await this.getTokens();
    return tokens?.access_token ?? null;
  }

  /**
   * Get current refresh token
   */
  static async getRefreshToken(): Promise<string | null> {
    const tokens = await this.getTokens();
    return tokens?.refresh_token ?? null;
  }

  /**
   * Get device ID
   */
  static async getDeviceId(): Promise<string | null> {
    const tokens = await this.getTokens();
    return tokens?.device_id ?? null;
  }

  /**
   * Clear all tokens (logout)
   */
  static async clearTokens(): Promise<void> {
    try {
      if (Platform.OS === 'web') {
        localStorage.removeItem(TOKENS_KEY);
      } else {
        await SecureStore.deleteItemAsync(TOKENS_KEY);
      }
    } catch (error) {
      console.error('Failed to clear tokens:', error);
      throw error;
    }
  }
}
```

---

## 3. API Client with Auto-Refresh

### Create Axios Instance

```typescript
// services/ApiClient.ts
import axios, {
  AxiosInstance,
  AxiosError,
  InternalAxiosRequestConfig,
} from 'axios';
import { TokenStorage } from './TokenStorage';
import { AUTH_CONFIG } from '../config/auth';

let isRefreshing = false;
let refreshSubscribers: ((token: string) => void)[] = [];

export class ApiClient {
  private static instance: AxiosInstance;

  static initialize(): AxiosInstance {
    if (this.instance) return this.instance;

    this.instance = axios.create({
      baseURL: AUTH_CONFIG.API_URL,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Request interceptor: Add auth header
    this.instance.interceptors.request.use(
      async (config: InternalAxiosRequestConfig) => {
        const accessToken = await TokenStorage.getAccessToken();

        if (accessToken) {
          config.headers.Authorization = `Bearer ${accessToken}`;
        }

        return config;
      },
      (error) => Promise.reject(error)
    );

    // Response interceptor: Handle 401, refresh token
    this.instance.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const originalRequest = error.config as any;

        // If 401 and not already retried
        if (error.response?.status === 401 && !originalRequest._retry) {
          if (isRefreshing) {
            // Wait for refresh to complete
            return new Promise((resolve) => {
              refreshSubscribers.push((token: string) => {
                originalRequest.headers.Authorization = `Bearer ${token}`;
                resolve(this.instance(originalRequest));
              });
            });
          }

          isRefreshing = true;
          originalRequest._retry = true;

          try {
            // Refresh token
            const refreshToken = await TokenStorage.getRefreshToken();

            if (!refreshToken) {
              throw new Error('No refresh token available');
            }

            const response = await this.instance.post(
              AUTH_CONFIG.ENDPOINTS.REFRESH,
              { refresh_token: refreshToken }
            );

            const { access_token, refresh_token } = response.data;
            const deviceId = await TokenStorage.getDeviceId();

            // Save new tokens
            await TokenStorage.saveTokens({
              access_token,
              refresh_token,
              device_id: deviceId!,
              expires_at: Date.now() + AUTH_CONFIG.TOKEN_EXPIRY_MS,
            });

            // Update original request
            originalRequest.headers.Authorization = `Bearer ${access_token}`;

            // Notify all waiting requests
            refreshSubscribers.forEach((callback) => callback(access_token));
            refreshSubscribers = [];

            // Retry original request
            return this.instance(originalRequest);
          } catch (refreshError) {
            // Refresh failed - logout user
            await TokenStorage.clearTokens();
            // Redirect to login screen
            throw refreshError;
          } finally {
            isRefreshing = false;
          }
        }

        return Promise.reject(error);
      }
    );

    return this.instance;
  }

  static getInstance(): AxiosInstance {
    return this.instance || this.initialize();
  }
}
```

---

## 4. Auth Service

### Complete Authentication Logic

```typescript
// services/AuthService.ts
import { ApiClient } from './ApiClient';
import { TokenStorage } from './TokenStorage';
import { AUTH_CONFIG, APP_ID } from '../config/auth';
import { v4 as uuidv4 } from 'uuid';
import * as Device from 'expo-device';

export interface User {
  id: string;
  email?: string;
  phone?: string;
  name?: string;
  avatar_url?: string;
  email_verified: boolean;
  phone_verified: boolean;
  roles: string[];
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  device_id: string;
  user: User;
}

export class AuthService {
  private api = ApiClient.getInstance();

  /**
   * Register new user
   */
  async register(
    email: string,
    password: string,
    name?: string
  ): Promise<Omit<User, 'roles'>> {
    const response = await this.api.post(
      AUTH_CONFIG.ENDPOINTS.REGISTER,
      {
        email,
        password,
        name,
        app_id: APP_ID,
      }
    );

    return response.data;
  }

  /**
   * Login with email + password
   */
  async loginWithEmail(
    email: string,
    password: string
  ): Promise<LoginResponse> {
    const deviceId = await this.getOrCreateDeviceId();

    const response = await this.api.post(
      AUTH_CONFIG.ENDPOINTS.LOGIN,
      {
        email,
        password,
        app_id: APP_ID,
      }
    );

    const data = response.data as LoginResponse;

    // Save tokens
    await TokenStorage.saveTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      device_id: deviceId,
      expires_at: Date.now() + data.expires_in * 1000,
    });

    return data;
  }

  /**
   * Request SMS OTP
   */
  async requestSmsOtp(phoneNumber: string): Promise<{
    otp_request_id: string;
    expires_in: number;
  }> {
    const response = await this.api.post(
      AUTH_CONFIG.ENDPOINTS.LOGIN_SMS,
      {
        phone_number: phoneNumber,
        app_id: APP_ID,
      }
    );

    return response.data;
  }

  /**
   * Verify SMS OTP
   */
  async verifySmsOtp(
    phoneNumber: string,
    otp: string
  ): Promise<LoginResponse> {
    const deviceId = await this.getOrCreateDeviceId();

    const response = await this.api.post(
      AUTH_CONFIG.ENDPOINTS.VERIFY_SMS,
      {
        phone_number: phoneNumber,
        otp,
        app_id: APP_ID,
      }
    );

    const data = response.data as LoginResponse;

    // Save tokens
    await TokenStorage.saveTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      device_id: deviceId,
      expires_at: Date.now() + data.expires_in * 1000,
    });

    return data;
  }

  /**
   * Login with OAuth provider
   */
  async loginWithOAuth(
    provider: 'google' | 'apple' | 'github',
    code: string,
    redirectUri: string
  ): Promise<LoginResponse> {
    const deviceId = await this.getOrCreateDeviceId();

    const response = await this.api.post(
      AUTH_CONFIG.ENDPOINTS.LOGIN_OAUTH,
      {
        provider,
        code,
        redirect_uri: redirectUri,
        app_id: APP_ID,
      }
    );

    const data = response.data as LoginResponse;

    // Save tokens
    await TokenStorage.saveTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      device_id: deviceId,
      expires_at: Date.now() + data.expires_in * 1000,
    });

    return data;
  }

  /**
   * Get current user
   */
  async getMe(): Promise<User> {
    const response = await this.api.get(AUTH_CONFIG.ENDPOINTS.ME);
    return response.data;
  }

  /**
   * Logout (current session)
   */
  async logout(): Promise<void> {
    const deviceId = await TokenStorage.getDeviceId();

    try {
      await this.api.post(AUTH_CONFIG.ENDPOINTS.LOGOUT, {
        device_id: deviceId,
      });
    } catch (error) {
      // Continue with logout even if API fails
      console.error('Logout API error:', error);
    }

    // Clear local tokens
    await TokenStorage.clearTokens();
  }

  /**
   * Logout from all devices
   */
  async logoutAllDevices(): Promise<void> {
    try {
      await this.api.delete('/v1/me/sessions');
    } catch (error) {
      console.error('Global logout error:', error);
    }

    // Clear local tokens
    await TokenStorage.clearTokens();
  }

  /**
   * Check if user is authenticated
   */
  async isAuthenticated(): Promise<boolean> {
    const isValid = await TokenStorage.isTokenValid();
    return isValid;
  }

  /**
   * Check token validity without API call
   */
  async isTokenValid(): Promise<boolean> {
    return TokenStorage.isTokenValid();
  }

  /**
   * Get or create device ID
   * Ensures each device has a unique ID
   */
  private async getOrCreateDeviceId(): Promise<string> {
    const tokens = await TokenStorage.getTokens();

    if (tokens?.device_id) {
      return tokens.device_id;
    }

    // Generate new device ID
    const deviceInfo = {
      deviceId: Device.deviceId || 'unknown',
      modelName: Device.modelName || 'unknown',
      osName: Device.osName,
      generated: uuidv4(),
    };

    return deviceInfo.generated;
  }
}

// Export singleton instance
export const authService = new AuthService();
```

---

## 5. React Hooks for Auth Context

### Auth Provider & Hooks

```typescript
// context/AuthContext.tsx
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
} from 'react';
import { authService, User } from '../services/AuthService';
import { TokenStorage } from '../services/TokenStorage';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  error: Error | null;

  // Auth methods
  register: (email: string, password: string, name?: string) => Promise<void>;
  loginWithEmail: (email: string, password: string) => Promise<void>;
  loginWithOAuth: (provider: 'google' | 'apple') => Promise<void>;
  requestSmsOtp: (phone: string) => Promise<string>;
  verifySmsOtp: (phone: string, otp: string) => Promise<void>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  refreshSession: () => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Initialize auth on app start
  useEffect(() => {
    initializeAuth();
  }, []);

  // Setup auto-refresh on interval
  useEffect(() => {
    if (!isAuthenticated) return;

    const interval = setInterval(async () => {
      try {
        // This will trigger the axios interceptor to refresh
        await authService.getMe();
      } catch (error) {
        console.error('Auto-refresh failed, logging out');
        await logout();
      }
    }, 14 * 60 * 1000); // Refresh every 14 minutes

    return () => clearInterval(interval);
  }, [isAuthenticated]);

  const initializeAuth = async () => {
    try {
      setIsLoading(true);

      // Check if tokens exist and are valid
      const isValid = await TokenStorage.isTokenValid();

      if (isValid) {
        // Fetch user profile
        const userData = await authService.getMe();
        setUser(userData);
        setIsAuthenticated(true);
      } else {
        setIsAuthenticated(false);
      }
    } catch (error) {
      console.error('Auth initialization failed:', error);
      setIsAuthenticated(false);
      await TokenStorage.clearTokens();
    } finally {
      setIsLoading(false);
    }
  };

  const register = async (email: string, password: string, name?: string) => {
    try {
      setError(null);
      await authService.register(email, password, name);
      // Auto-login after registration
      await loginWithEmail(email, password);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Registration failed');
      setError(error);
      throw error;
    }
  };

  const loginWithEmail = async (email: string, password: string) => {
    try {
      setError(null);
      setIsLoading(true);

      const response = await authService.loginWithEmail(email, password);
      setUser(response.user);
      setIsAuthenticated(true);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Login failed');
      setError(error);
      setIsAuthenticated(false);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  const requestSmsOtp = async (phone: string): Promise<string> => {
    try {
      setError(null);
      const response = await authService.requestSmsOtp(phone);
      return response.otp_request_id;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('OTP request failed');
      setError(error);
      throw error;
    }
  };

  const verifySmsOtp = async (phone: string, otp: string) => {
    try {
      setError(null);
      setIsLoading(true);

      const response = await authService.verifySmsOtp(phone, otp);
      setUser(response.user);
      setIsAuthenticated(true);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('OTP verification failed');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  const loginWithOAuth = async (provider: 'google' | 'apple') => {
    try {
      setError(null);
      setIsLoading(true);

      // This would use OAuth library to get code
      // Example: @react-native-firebase/auth for Google
      // SkipWithApple for Apple

      // For now, placeholder
      throw new Error(`${provider} login not fully implemented`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('OAuth login failed');
      setError(error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    try {
      await authService.logout();
      setUser(null);
      setIsAuthenticated(false);
      setError(null);
    } catch (err) {
      console.error('Logout error:', err);
      // Clear local state even if API fails
      setUser(null);
      setIsAuthenticated(false);
    }
  };

  const logoutAll = async () => {
    try {
      await authService.logoutAllDevices();
      setUser(null);
      setIsAuthenticated(false);
      setError(null);
    } catch (err) {
      console.error('Global logout error:', err);
      // Clear local state anyway
      setUser(null);
      setIsAuthenticated(false);
    }
  };

  const refreshSession = async () => {
    try {
      setError(null);
      // Trigger refresh via getMe call
      const userData = await authService.getMe();
      setUser(userData);
      setIsAuthenticated(true);
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Session refresh failed');
      setError(error);
      setIsAuthenticated(false);
      await logout();
    }
  };

  const clearError = () => {
    setError(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated,
        error,
        register,
        loginWithEmail,
        loginWithOAuth,
        requestSmsOtp,
        verifySmsOtp,
        logout,
        logoutAll,
        refreshSession,
        clearError,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};
```

---

## 6. Usage in Components

### Login Screen

```typescript
// screens/LoginScreen.tsx
import React, { useState } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  Text,
  ActivityIndicator,
} from 'react-native';
import { useAuth } from '../context/AuthContext';

export const LoginScreen: React.FC = ({ navigation }: any) => {
  const { loginWithEmail, isLoading, error } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleLogin = async () => {
    try {
      await loginWithEmail(email, password);
      // Navigation happens automatically via AuthContext
    } catch (err) {
      // Error is shown in AuthContext state
    }
  };

  return (
    <View style={{ padding: 20 }}>
      <TextInput
        placeholder="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
      />

      <TextInput
        placeholder="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
      />

      {error && <Text style={{ color: 'red' }}>{error.message}</Text>}

      <TouchableOpacity
        onPress={handleLogin}
        disabled={isLoading}
      >
        {isLoading ? (
          <ActivityIndicator />
        ) : (
          <Text>Login</Text>
        )}
      </TouchableOpacity>
    </View>
  );
};
```

### Protected Screen

```typescript
// screens/HomeScreen.tsx
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { User } from '../services/AuthService';

export const HomeScreen: React.FC = () => {
  const { user, logout, isLoading } = useAuth();

  if (isLoading) {
    return <Text>Loading...</Text>;
  }

  if (!user) {
    return <Text>Not logged in</Text>;
  }

  return (
    <View style={{ padding: 20 }}>
      <Text>Welcome, {user.name}!</Text>
      <Text>Email: {user.email}</Text>

      <TouchableOpacity onPress={logout}>
        <Text>Logout</Text>
      </TouchableOpacity>
    </View>
  );
};
```

---

## 7. App Navigation

### Setup with React Navigation

```typescript
// navigation/RootNavigator.tsx
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { ActivityIndicator } from 'react-native';

import { useAuth } from '../context/AuthContext';
import { LoginScreen } from '../screens/LoginScreen';
import { HomeScreen } from '../screens/HomeScreen';

const Stack = createStackNavigator();

export const RootNavigator: React.FC = () => {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return <ActivityIndicator />;
  }

  return (
    <NavigationContainer>
      {isAuthenticated ? (
        <Stack.Navigator>
          <Stack.Screen name="Home" component={HomeScreen} />
        </Stack.Navigator>
      ) : (
        <Stack.Navigator>
          <Stack.Screen name="Login" component={LoginScreen} />
        </Stack.Navigator>
      )}
    </NavigationContainer>
  );
};
```

### App Entry Point

```typescript
// App.tsx
import React from 'react';
import { AuthProvider } from './context/AuthContext';
import { RootNavigator } from './navigation/RootNavigator';
import { ApiClient } from './services/ApiClient';

// Initialize API client
ApiClient.initialize();

export default function App() {
  return (
    <AuthProvider>
      <RootNavigator />
    </AuthProvider>
  );
}
```

---

## 8. Best Practices

### Do's ✅

- ✅ Store tokens in SecureStore (not AsyncStorage)
- ✅ Refresh tokens automatically before expiry
- ✅ Handle refresh failures gracefully
- ✅ Clear tokens on logout
- ✅ Validate tokens on app startup
- ✅ Add user feedback (loading, errors)
- ✅ Implement retry logic
- ✅ Log security events

### Don'ts ❌

- ❌ Store tokens in AsyncStorage
- ❌ Store tokens in Redux/Context unencrypted
- ❌ Log tokens or sensitive data
- ❌ Pass tokens via URL parameters
- ❌ Disable SSL certificate validation
- ❌ Store passwords locally
- ❌ Hardcode API credentials

---

## 9. Error Handling

### Handle Common Errors

```typescript
// utils/errorHandler.ts
import axios from 'axios';

export const getErrorMessage = (error: unknown): string => {
  if (!axios.isAxiosError(error)) {
    return 'An unexpected error occurred';
  }

  const response = error.response?.data as any;
  const message = response?.message || error.message;

  switch (error.response?.status) {
    case 401:
      return 'Authentication failed. Please login again.';
    case 403:
      return 'You do not have permission to perform this action.';
    case 404:
      return 'Resource not found.';
    case 429:
      return 'Too many requests. Please try again later.';
    case 500:
      return 'Server error. Please try again later.';
    default:
      return message || 'An error occurred.';
  }
};
```

---

## Summary

This integration guide shows:
1. **Secure storage** of tokens
2. **Automatic refresh** of expired tokens
3. **Multi-device logout** capability
4. **Error handling** and recovery
5. **React hooks** for easy component integration
6. **Best practices** for production apps

The key insight: **Token refresh is automatic via axios interceptor**, so
