import { useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import type { PageContext } from '@genohype/assistant-ui'

interface PageContextResult {
  pageContext: PageContext | null
  suggestions: Array<{ title: string; message: string }>
}

/**
 * Detect current page type and return appropriate assistant context + suggestions.
 */
export function usePageContext(): PageContextResult {
  const location = useLocation()

  const pageContext = useMemo((): PageContext | null => {
    const path = location.pathname

    const geneMatch = path.match(/^\/gene\/(.+?)(?:\?|$)/)
    if (geneMatch) {
      return { type: 'Gene', id: decodeURIComponent(geneMatch[1]) }
    }

    const variantMatch = path.match(/^\/variant\/(.+?)(?:\?|$)/)
    if (variantMatch) {
      return { type: 'Variant', id: decodeURIComponent(variantMatch[1]) }
    }

    const regionMatch = path.match(/^\/region\/(.+?)(?:\?|$)/)
    if (regionMatch) {
      return { type: 'Region', id: decodeURIComponent(regionMatch[1]) }
    }

    return null
  }, [location.pathname])

  const suggestions = useMemo(() => {
    if (!pageContext) return []

    switch (pageContext.type) {
      case 'Variant':
        return [
          { title: 'Display the variant summary', message: 'Please display the variant summary' },
          { title: 'Interpret this variant', message: 'Can you help me interpret the clinical significance and population frequency of this variant?' },
          { title: 'Is this variant too common?', message: "Is this variant's allele frequency too high for it to cause a rare Mendelian disease?" },
          { title: 'Analyze expression at this location (Pext)', message: "Analyze the Pext score for this variant's location. Is it in a functionally important region?" },
          { title: 'Check in silico predictors', message: 'What do in silico predictors like REVEL and CADD say about this variant?' },
        ]
      case 'Gene':
        return [
          { title: 'Summarize gene constraint', message: "Summarize this gene's constraint scores, like pLI and missense o/e." },
          { title: 'Check tissue expression', message: 'In which tissues is this gene most highly expressed?' },
          { title: 'Look up Mendelian disease', message: 'Is this gene associated with any Mendelian diseases?' },
          { title: 'Analyze expression regions (Pext)', message: 'Provide a Pext analysis for this gene to identify functionally important regions.' },
        ]
      case 'Region':
        return [
          { title: 'Summarize this region', message: 'What genes and notable variants are in this genomic region?' },
        ]
      default:
        return []
    }
  }, [pageContext])

  return { pageContext, suggestions }
}
