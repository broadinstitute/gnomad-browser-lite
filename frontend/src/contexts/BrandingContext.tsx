import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { BrandingConfig } from '../api/types';
import { api } from '../api/client';

const DEFAULT_BRANDING: BrandingConfig = {
  name: 'gnomAD Browser Lite',
  navbar_color: '#333',
  accent_color: '#0066cc',
};

const BrandingContext = createContext<BrandingConfig>(DEFAULT_BRANDING);

export function useBranding(): BrandingConfig {
  return useContext(BrandingContext);
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [branding, setBranding] = useState<BrandingConfig>(DEFAULT_BRANDING);

  useEffect(() => {
    api.getConfig().then(setBranding).catch(() => {
      // Use defaults on error
    });
  }, []);

  // Inject CSS variables into :root whenever branding changes
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--navbar-color', branding.navbar_color || '#333');
    root.style.setProperty('--accent-color', branding.accent_color || '#0066cc');
  }, [branding]);

  return (
    <BrandingContext.Provider value={branding}>
      {children}
    </BrandingContext.Provider>
  );
}
