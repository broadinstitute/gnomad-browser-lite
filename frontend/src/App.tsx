import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import styled, { createGlobalStyle } from 'styled-components';
import { HomePage } from './pages/HomePage';
import { GenePage } from './pages/GenePage';
import { RegionPage } from './pages/RegionPage';

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
    color: #0066cc;
  }
`;

const Nav = styled.nav`
  background: #333;
  padding: 1rem;
`;

const NavContent = styled.div`
  max-width: 1400px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  gap: 1rem;
`;

const NavTitle = styled(Link)`
  color: white;
  text-decoration: none;
  font-weight: 600;
  font-size: 1.1rem;

  &:hover {
    color: #ccc;
  }
`;

const NavLinks = styled.div`
  display: flex;
  gap: 1rem;
  margin-left: auto;
`;

const NavLink = styled(Link)`
  color: #aaa;
  text-decoration: none;

  &:hover {
    color: white;
  }
`;

function App() {
  return (
    <BrowserRouter>
      <GlobalStyle />
      <Nav>
        <NavContent>
          <NavTitle to="/">gnomAD Browser Lite</NavTitle>
          <NavLinks>
            <NavLink to="/">Home</NavLink>
          </NavLinks>
        </NavContent>
      </Nav>

      <main>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/gene/:geneId" element={<GenePage />} />
          <Route path="/region/:regionId" element={<RegionPage />} />
        </Routes>
      </main>
    </BrowserRouter>
  );
}

export default App;
