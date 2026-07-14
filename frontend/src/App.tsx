import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import styled, { createGlobalStyle } from 'styled-components';
// NOTE: the "Ask … Assistant" panel + chat-history sidebar are temporarily
// hidden (see AppContent / App). AssistantProvider is kept so the CopilotKit
// action registration in ToolActionRegistrar still has its context.
import { AssistantProvider } from '@genohype/assistant-ui';
import { useGnomadVariantActions } from './assistant/hooks/useGnomadVariantActions';
import { HomePage } from './pages/HomePage';
import { GenePage } from './pages/GenePage';
import { RegionPage } from './pages/RegionPage';
import { VariantPage } from './pages/VariantPage';
import { QCReportPage } from './pages/QCReportPage';
import { CacheDevTool } from './components/CacheDevTool';
import { BrandingProvider, useBranding } from './contexts/BrandingContext';

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

function AppContent() {
  const branding = useBranding();
  const displayName = branding.full_title || branding.short_name || branding.name;

  return (
    <>
    <ToolActionRegistrar />
    {/* "Ask … Assistant" panel temporarily removed — render the app directly. */}
    <GlobalStyle />
    <Nav>
      <NavContent>
        <NavTitle to="/">
          {branding.logo_url && <NavLogo src={branding.logo_url} alt="" />}
        </NavTitle>
        <NavCenter>{displayName}</NavCenter>
        <NavLinks>
          <NavLink to="/">Home</NavLink>
          <NavLink to="/qc">QC Report</NavLink>
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
        <Route path="/qc" element={<QCReportPage />} />
      </Routes>
    </main>
    {import.meta.env.DEV && <CacheDevTool />}
    </>
  );
}

function App() {
  return (
    <BrowserRouter>
      <BrandingProvider>
        <AssistantProvider runtimeUrl="/api/copilotkit" defaultMode="closed">
          <AppContent />
        </AssistantProvider>
      </BrandingProvider>
    </BrowserRouter>
  );
}

export default App;
