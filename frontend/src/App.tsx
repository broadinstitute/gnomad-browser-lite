import { BrowserRouter, Routes, Route, Link, useNavigate } from 'react-router-dom';
import styled, { createGlobalStyle } from 'styled-components';
import { AssistantProvider, AssistantPanel, ChatHistorySidebar, useAssistantContext } from '@genohype/assistant-ui';
import { useGnomadVariantActions } from './assistant/hooks/useGnomadVariantActions';
import { useCallback, useRef, useEffect } from 'react';
import { HomePage } from './pages/HomePage';
import { GenePage } from './pages/GenePage';
import { RegionPage } from './pages/RegionPage';
import { VariantPage } from './pages/VariantPage';
import { CacheDevTool } from './components/CacheDevTool';
import { BrandingProvider, useBranding } from './contexts/BrandingContext';
import { usePageContext } from './hooks/usePageContext';

const GlobalStyle = createGlobalStyle`
  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen,
      Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
    background: #fff;
    color: #333;
  }

  a {
    color: var(--accent-color, #0066cc);
  }
`;

const Nav = styled.nav`
  background: var(--navbar-color, #333);
  padding: 1rem;
`;

const NavContent = styled.div`
  max-width: 1400px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 1rem;
`;

const NavCenter = styled.div`
  text-align: center;
  font-weight: 600;
  font-size: 1.1rem;
  color: var(--navbar-text-color, white);
`;

const NavTitle = styled(Link)`
  color: var(--navbar-text-color, white);
  text-decoration: none;
  font-weight: 600;
  font-size: 1.1rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;

  &:hover {
    color: var(--accent-color, #0066cc);
  }
`;

const NavLogo = styled.img`
  height: 40px;
  width: auto;
`;

const NavLinks = styled.div`
  display: flex;
  gap: 1rem;
`;

const NavLink = styled(Link)`
  color: var(--navbar-text-color, #aaa);
  text-decoration: none;

  &:hover {
    color: var(--accent-color, #0066cc);
  }
`;

const NavExternalLink = styled.a`
  color: var(--navbar-text-color, #aaa);
  text-decoration: none;

  &:hover {
    color: var(--accent-color, #0066cc);
  }
`;

function ToolActionRegistrar() {
  useGnomadVariantActions();
  return null;
}

function FullscreenSidebar() {
  const { runtimeUrl, getAuthToken, threadId, setThreadId, newChat, threadVersion } = useAssistantContext();
  const refreshRef = useRef<(() => void) | null>(null);

  const fetchThreads = useCallback(async () => {
    const headers: Record<string, string> = {};
    if (getAuthToken) {
      try { headers.Authorization = `Bearer ${await getAuthToken()}` } catch { /* noop */ }
    }
    const res = await fetch(`${runtimeUrl}/threads`, { headers });
    if (!res.ok) return [];
    return res.json();
  }, [runtimeUrl, getAuthToken]);

  const deleteThread = useCallback(async (id: string) => {
    const headers: Record<string, string> = {};
    if (getAuthToken) {
      try { headers.Authorization = `Bearer ${await getAuthToken()}` } catch { /* noop */ }
    }
    await fetch(`${runtimeUrl}/threads/${id}`, { method: 'DELETE', headers });
  }, [runtimeUrl, getAuthToken]);

  // Re-fetch sidebar when threadVersion changes (new chat created, message sent, etc.)
  useEffect(() => {
    // Small delay to let the POST /threads complete
    const timer = setTimeout(() => refreshRef.current?.(), 200);
    return () => clearTimeout(timer);
  }, [threadVersion]);

  return (
    <ChatHistorySidebar
      currentThreadId={threadId}
      onNewChat={newChat}
      onRefreshRef={(fn) => { refreshRef.current = fn; }}
      onSelectThread={setThreadId}
      fetchThreads={fetchThreads}
      deleteThread={deleteThread}
    />
  );
}

function AppContent() {
  const branding = useBranding();
  const navigate = useNavigate();
  const { pageContext, suggestions } = usePageContext();
  const displayName = branding.full_title || branding.short_name || branding.name;

  return (
    <>
    <ToolActionRegistrar />
    <AssistantPanel
      defaultMode="closed"
      title={`${branding.short_name || 'Genomic'} Assistant`}
      toggleLabel={`Ask ${branding.short_name || 'Genomic'} Assistant`}
      suggestions={suggestions}
      pageContext={pageContext}
      onNavigate={(url: string) => navigate(url)}
      allowAdmin={true}
      modelOptions={[
        { value: 'gemini-3.1-flash', label: 'Gemini 3.1 Flash' },
        { value: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
        { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
        { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      ]}
    >
      <GlobalStyle />
      <Nav>
        <NavContent>
          <NavTitle to="/">
            {branding.logo_url && <NavLogo src={branding.logo_url} alt="" />}
          </NavTitle>
          <NavCenter>{displayName}</NavCenter>
          <NavLinks>
            <NavLink to="/">Home</NavLink>
            {branding.external_links?.map((link) => (
              <NavExternalLink
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {link.label}
              </NavExternalLink>
            ))}
          </NavLinks>
        </NavContent>
      </Nav>

      <main>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/gene/:geneId" element={<GenePage />} />
          <Route path="/region/:regionId" element={<RegionPage />} />
          <Route path="/variant/:variantId" element={<VariantPage />} />
        </Routes>
      </main>
      {import.meta.env.DEV && <CacheDevTool />}
    </AssistantPanel>
    </>
  );
}

function App() {
  return (
    <BrowserRouter>
      <BrandingProvider>
        <AssistantProvider runtimeUrl="/api/copilotkit" defaultMode="closed" persistentSidebar={<FullscreenSidebar />}>
          <AppContent />
        </AssistantProvider>
      </BrandingProvider>
    </BrowserRouter>
  );
}

export default App;
