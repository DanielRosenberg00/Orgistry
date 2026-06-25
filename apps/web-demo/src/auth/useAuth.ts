import { useContext } from 'react';
import { AuthContext, type AuthContextValue } from './auth-context';

/** Access the authentication state. Must be used within an `AuthProvider`. */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return value;
}
