import { useMemo, useState } from 'react'
import { jsPDF } from 'jspdf'
import * as pdfjsLib from 'pdfjs-dist'
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import './App.css'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc

const normalizeBlock = (block) => block.replace(/\s+/g, ' ').trim()
const cleanLine = (line) => normalizeBlock(line).replace(/\s+([,.;:!?])/g, '$1')
const sanitizeExtractedText = (text) =>
  text
    .replace(/%Ï/g, '•')
    .replace(/Ï/g, '•')
    .replace(/[�]/g, '')
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/\s+\n/g, '\n')
    .trim()

const collapseSpacedCharacters = (text) =>
  text.replace(/(?:\b[\p{L}\d]\s){3,}[\p{L}\d]\b/gu, (match) =>
    match.replace(/\s+/g, ''),
  )

const mapPdfFontToJsPdf = (fontName) => {
  const normalizedFont = (fontName || '').toLowerCase()
  if (normalizedFont.includes('times')) {
    return 'times'
  }
  if (normalizedFont.includes('courier')) {
    return 'courier'
  }
  return 'helvetica'
}

const toSafeFileName = (value) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9-_ ]/g, '')
    .trim()
    .replace(/\s+/g, '_')

const groupPageItemsToLines = (items, pageNumber, pageHeight) => {
  const sortedItems = [...items].sort((a, b) => {
    const ay = typeof a.transform?.[5] === 'number' ? a.transform[5] : 0
    const by = typeof b.transform?.[5] === 'number' ? b.transform[5] : 0
    if (Math.abs(ay - by) > 1.8) {
      return by - ay
    }
    const ax = typeof a.transform?.[4] === 'number' ? a.transform[4] : 0
    const bx = typeof b.transform?.[4] === 'number' ? b.transform[4] : 0
    return ax - bx
  })

  const lines = []

  sortedItems.forEach((item) => {
    const text = 'str' in item ? item.str : ''
    if (!text || !text.trim()) {
      return
    }

    const y = typeof item.transform?.[5] === 'number' ? item.transform[5] : 0
    const x = typeof item.transform?.[4] === 'number' ? item.transform[4] : 0
    const height = typeof item.height === 'number' ? item.height : 0

    const existingLine = lines.find((line) => Math.abs(line.y - y) <= 2.2)
    if (existingLine) {
      existingLine.parts.push({
        text: text.trim(),
        x,
        height,
        fontName: typeof item.fontName === 'string' ? item.fontName : '',
      })
      existingLine.maxHeight = Math.max(existingLine.maxHeight, height)
      return
    }

    lines.push({
      y,
      maxHeight: height,
      parts: [
        {
          text: text.trim(),
          x,
          height,
          fontName: typeof item.fontName === 'string' ? item.fontName : '',
        },
      ],
    })
  })

  return lines
    .map((line) => {
      const sortedParts = line.parts
        .sort((a, b) => a.x - b.x)
      const content = sortedParts.map((part) => part.text).join(' ')
      const lineFont = sortedParts.find((part) => part.fontName)?.fontName ?? ''

      return {
        text: collapseSpacedCharacters(sanitizeExtractedText(cleanLine(content))),
        fontSize: line.maxHeight,
        fontName: lineFont,
        y: line.y,
        pageNumber,
        pageHeight,
      }
    })
    .filter((line) => line.text.length > 0)
}

const filterRepeatedNoiseLines = (lines, totalPages) => {
  const lineCount = new Map()

  lines.forEach((line) => {
    const key = line.text.toLowerCase().trim()
    if (key.length >= 6) {
      lineCount.set(key, (lineCount.get(key) ?? 0) + 1)
    }
  })

  const repeatThreshold = Math.max(2, Math.ceil(totalPages * 0.4))

  return lines.filter((line) => {
    const key = line.text.toLowerCase().trim()
    const repeats = lineCount.get(key) ?? 0
    const isPageEdge =
      typeof line.y === 'number' &&
      typeof line.pageHeight === 'number' &&
      (line.y < 70 || line.y > line.pageHeight - 70)

    const isNoiseByRepetition = repeats >= repeatThreshold && isPageEdge
    return !isNoiseByRepetition
  })
}

const isHeadingText = (text) => {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length < 3 || trimmed.length > 120) {
    return false
  }

  const numberedCompact = /^\d+(?:\.\d+)*\.?\s*[A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ0-9 _/&()%-]{2,}$/.test(
    trimmed,
  )
  const numberedDashed = /^\d+(?:\.\d+)*\s*[-)]\s*[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(trimmed)
  const uppercaseTitle = /^[A-ZÁÉÍÓÚÑ0-9][A-ZÁÉÍÓÚÑ0-9 .:()/_-]{3,}$/.test(trimmed)

  return numberedCompact || numberedDashed || uppercaseTitle
}

const isLikelyTitle = (line, bigFontThreshold) => {
  const text = line.text
  const titleBySize = line.fontSize >= bigFontThreshold && text.length < 120
  const numberedTitle = /^\d+(?:\.\d+)*\.?\s*[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(text)
  const upperTitle = /^[A-ZÁÉÍÓÚÑ0-9][A-ZÁÉÍÓÚÑ0-9 .:()/-]{4,}$/.test(text)
  const colonTitle = /^[A-Za-zÁÉÍÓÚÑáéíóúñ0-9 ]{3,}:\s*$/.test(text)

  return titleBySize || numberedTitle || upperTitle || colonTitle || isHeadingText(text)
}

const extractSectionsFromLines = (lines) => {
  if (!lines.length) {
    return []
  }

  const fontSizes = lines.map((line) => line.fontSize).filter((size) => size > 0)
  const maxSize = fontSizes.length ? Math.max(...fontSizes) : 10
  const minBigThreshold = Math.max(10.5, maxSize * 0.82)

  const sections = []
  let currentSection = null

  lines.forEach((line, index) => {
    const newTitle = isLikelyTitle(line, minBigThreshold)
    if (newTitle) {
      if (currentSection && currentSection.content.trim().length > 20) {
        sections.push(currentSection)
      }

      currentSection = {
        id: `section-${index}`,
        title: line.text.replace(/:$/, '').slice(0, 120),
        content: '',
        titleFont: mapPdfFontToJsPdf(line.fontName),
        bodyFont: 'helvetica',
        selected: true,
      }
      return
    }

    if (!currentSection) {
      currentSection = {
        id: `section-${index}`,
        title: 'Introducción',
        content: '',
        titleFont: 'helvetica',
        bodyFont: 'helvetica',
        selected: true,
      }
    }

    currentSection.content = `${currentSection.content} ${line.text}`.trim()
    currentSection.bodyFont = mapPdfFontToJsPdf(line.fontName)
  })

  if (currentSection && currentSection.content.trim().length > 20) {
    sections.push(currentSection)
  }

  return sections.filter((section) => section.title.trim().length > 0)
}

const extractSectionsByHeadingRegex = (rawText) => {
  const normalizedText = rawText.replace(/\r/g, '').trim()
  if (!normalizedText) {
    return []
  }

  const headingPattern =
    /(?:^|\n)\s*(\d+(?:\.\d+)*\.?\s*[A-Za-zÁÉÍÓÚÑáéíóúñ][A-Za-zÁÉÍÓÚÑáéíóúñ0-9 _/&()%-]{2,}|[A-ZÁÉÍÓÚÑ0-9][A-ZÁÉÍÓÚÑ0-9 .:()/_-]{3,})\s*(?=\n|$)/gm

  const matches = []
  let match = headingPattern.exec(normalizedText)
  while (match) {
    const title = cleanLine(match[1] ?? '')
    if (isHeadingText(title)) {
      matches.push({
        title: title.replace(/:$/, ''),
        start: match.index + match[0].indexOf(match[1]),
      })
    }
    match = headingPattern.exec(normalizedText)
  }

  if (!matches.length) {
    return []
  }

  const sections = matches.map((current, index) => {
    const next = matches[index + 1]
    const contentStart = current.start + current.title.length
    const contentEnd = next ? next.start : normalizedText.length
    const content = normalizeBlock(normalizedText.slice(contentStart, contentEnd))

    return {
      id: `fallback-section-${index}`,
      title: current.title.slice(0, 120),
      content: sanitizeExtractedText(content),
      titleFont: mapPdfFontToJsPdf(current.title),
      bodyFont: 'helvetica',
      selected: true,
    }
  })

  return sections.filter((section) => section.content.length > 15)
}

function App() {
  const [clientName, setClientName] = useState('')
  const [sourceFileName, setSourceFileName] = useState('')
  const [sections, setSections] = useState([])
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState('')

  const selectedSections = useMemo(
    () => sections.filter((section) => section.selected),
    [sections],
  )

  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    setError('')
    setIsProcessing(true)
    setSourceFileName(file.name)

    try {
      const arrayBuffer = await file.arrayBuffer()
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer })
      const pdf = await loadingTask.promise
      const allLines = []

      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber)
        const viewport = page.getViewport({ scale: 1 })
        const textContent = await page.getTextContent()
        const pageLines = groupPageItemsToLines(
          textContent.items,
          pageNumber,
          viewport.height,
        )
        allLines.push(...pageLines)
      }

      const cleanedLines = filterRepeatedNoiseLines(allLines, pdf.numPages)

      if (!cleanedLines.length) {
        throw new Error(
          'No se encontró texto legible en el PDF. Verifica que no sea solo imagen.',
        )
      }

      const linesText = sanitizeExtractedText(cleanedLines.map((line) => line.text).join('\n'))
      let parsedSections = extractSectionsFromLines(cleanedLines)
      if (!parsedSections.length) {
        parsedSections = extractSectionsByHeadingRegex(linesText)
      }
      if (!parsedSections.length) {
        throw new Error(
          'No se detectaron títulos claros en el PDF. Verifica que tenga texto seleccionable.',
        )
      }

      setSections(parsedSections)
    } catch (loadError) {
      setSections([])
      setError(loadError instanceof Error ? loadError.message : 'Error desconocido.')
    } finally {
      setIsProcessing(false)
      event.target.value = ''
    }
  }

  const toggleSection = (id) => {
    setSections((currentSections) =>
      currentSections.map((section) =>
        section.id === id ? { ...section, selected: !section.selected } : section,
      ),
    )
  }

  const toggleAll = (selectedValue) => {
    setSections((currentSections) =>
      currentSections.map((section) => ({ ...section, selected: selectedValue })),
    )
  }

  const generateManual = () => {
    if (!clientName.trim()) {
      setError('Ingresa el nombre del cliente para generar el manual.')
      return
    }

    if (!selectedSections.length) {
      setError('Selecciona al menos una sección en el checklist.')
      return
    }

    setError('')

    const pdf = new jsPDF({ unit: 'pt', format: 'a4' })
    const pageWidth = pdf.internal.pageSize.getWidth()
    const pageHeight = pdf.internal.pageSize.getHeight()
    const marginX = 50
    const maxTextWidth = pageWidth - marginX * 2
    let cursorY = 70

    const addPageIfNeeded = (requiredSpace = 20) => {
      if (cursorY + requiredSpace > pageHeight - 60) {
        pdf.addPage()
        cursorY = 60
      }
    }

    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(22)
    pdf.text(`Manual de Usuario - ${clientName.trim()}`, marginX, cursorY)
    cursorY += 36
    cursorY += 4

    selectedSections.forEach((section) => {
      addPageIfNeeded(48)
      pdf.setFont('helvetica', 'bold')
      pdf.setFontSize(14)
      pdf.setFont(section.titleFont || 'helvetica', 'bold')
      const titleLines = pdf.splitTextToSize(section.title, maxTextWidth)
      pdf.text(titleLines, marginX, cursorY)
      cursorY += titleLines.length * 18

      pdf.setFont(section.bodyFont || 'helvetica', 'normal')
      pdf.setFontSize(11)
      const cleanedSectionContent = sanitizeExtractedText(section.content)
      const paragraphLines = pdf.splitTextToSize(cleanedSectionContent, maxTextWidth)
      paragraphLines.forEach((line) => {
        addPageIfNeeded(16)
        pdf.text(line, marginX, cursorY)
        cursorY += 16
      })

      cursorY += 14
    })

    const customerSafeName = toSafeFileName(clientName) || 'cliente'
    pdf.save(`Manual_Usuario_${customerSafeName}.pdf`)
  }

  return (
    <main className="app">
      <section className="panel">
        <div className="panel-top">
          <div className="brand">
            <img src="/logo-mozart.png" alt="Mozart Cuidador Digital" className="brand-logo" />
            <h1>Automatizador de Manuales de Usuario</h1>
          </div>
          <span className="chip">PDF a Manual</span>
        </div>
        <p className="description">
          Carga un PDF base, selecciona por checklist qué contenido incluir y genera un
          nuevo manual con el nombre del cliente.
        </p>

        <label className="field">
          <span>Nombre del cliente</span>
          <input
            type="text"
            placeholder="Ej: Clínica Esperanza"
            value={clientName}
            onChange={(event) => setClientName(event.target.value)}
          />
        </label>

        <label className="field">
          <span>PDF base</span>
          <input type="file" accept="application/pdf" onChange={handleFileUpload} />
        </label>

        <div className="actions">
          <button type="button" onClick={() => toggleAll(true)} disabled={!sections.length}>
            Marcar todo
          </button>
          <button type="button" onClick={() => toggleAll(false)} disabled={!sections.length}>
            Desmarcar todo
          </button>
          <button
            type="button"
            className="primary"
            onClick={generateManual}
            disabled={!sections.length || isProcessing}
          >
            Generar manual PDF
          </button>
        </div>

        {isProcessing && <p className="status">Analizando contenido del PDF...</p>}
        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel">
        <div className="panel-top">
          <h2>Checklist por Títulos Detectados</h2>
          <div className="stats">
            <span>Detectadas: {sections.length}</span>
            <span>Seleccionadas: {selectedSections.length}</span>
          </div>
        </div>
        <p className="description">Los nombres se toman de los encabezados/títulos del PDF.</p>

        <div className="sections">
          {sections.map((section) => (
            <label key={section.id} className="section-item">
              <input
                type="checkbox"
                checked={section.selected}
                onChange={() => toggleSection(section.id)}
              />
              <span>
                <strong>{section.title}</strong>
                <small>{section.content.slice(0, 220)}...</small>
              </span>
            </label>
          ))}
          {!sections.length && (
            <p className="status">Carga un PDF para construir el checklist automáticamente.</p>
          )}
        </div>
      </section>
    </main>
  )
}

export default App
