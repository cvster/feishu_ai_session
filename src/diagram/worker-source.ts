/** Runs away from the bridge event loop; the parent enforces a hard deadline. */
export const diagramWorkerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { renderMermaidSVG } = await import(workerData.mermaid);
  const { Resvg } = await import(workerData.resvg);
  const { SaxesParser } = await import(workerData.saxes);
  const colors = {
    bg:'#ffffff', fg:'#172b4d', line:'#64748b', accent:'#2563eb',
    muted:'#64748b', surface:'#f1f5f9', border:'#cbd5e1',
    '_text':'#172b4d', '_text-sec':'#64748b', '_text-muted':'#64748b',
    '_text-faint':'#c5cad3', '_line':'#64748b', '_arrow':'#2563eb',
    '_node-fill':'#f1f5f9', '_node-stroke':'#cbd5e1', '_group-fill':'#ffffff',
    '_group-hdr':'#f3f4f6', '_inner-stroke':'#e3e6ea', '_key-badge':'#e8eaed'
  };
  let svg = renderMermaidSVG(workerData.source, { ...colors, font:'Noto Sans CJK SC', transparent:false });
  // Flatten the library's theme variables for resvg, and remove its Google font imports.
  svg = svg.replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/ style="--bg:[^"]*"/, '')
    .replace(/var\(--([\w-]+)\)/g, (_, name) => {
      if (!Object.hasOwn(colors, name)) throw Error('Unsupported diagram color');
      return colors[name];
    });
  svg = svg.replace(/(<svg\b[^>]*>)/, '$1<rect width="100%" height="100%" fill="#ffffff"/><style>text{font-family:"Noto Sans CJK SC",sans-serif}.mono{font-family:monospace}</style>');
  if (Buffer.byteLength(svg) > 2 * 1024 * 1024 || /var\(|color-mix\(|@import/i.test(svg)) throw Error('Unsupported SVG');
  const allowed = new Set(['svg','g','defs','marker','path','polyline','polygon','line','rect','circle','ellipse','text','tspan','title','desc','style','clipPath']);
  const parser = new SaxesParser({ xmlns:true });
  let width = 0, height = 0, elements = 0;
  parser.on('doctype', () => { throw Error('SVG doctype forbidden'); });
  parser.on('processinginstruction', () => { throw Error('SVG instructions forbidden'); });
  parser.on('opentag', tag => {
    if (!allowed.has(tag.name) || tag.uri !== 'http://www.w3.org/2000/svg' || ++elements > 15000) throw Error('Unsafe SVG element');
    if (tag.name === 'svg') {
      if (width) throw Error('Nested SVG forbidden');
      width = Number(tag.attributes.width?.value); height = Number(tag.attributes.height?.value);
    }
    for (const attr of Object.values(tag.attributes)) {
      if (/^on/i.test(attr.name) || /href$/i.test(attr.name) || /(?:javascript:|data:|https?:|@import|expression\s*\()/i.test(attr.value) && attr.name !== 'xmlns') throw Error('Unsafe SVG attribute');
      if (/url\s*\(/i.test(attr.value) && !/^url\(#[\w-]+\)$/.test(attr.value)) throw Error('External SVG resource');
      if (attr.name === 'style' && /[{}<>]/.test(attr.value)) throw Error('Unsafe SVG style');
    }
  });
  parser.write(svg).close();
  if (!(width > 0 && height > 0 && width <= 12000 && height <= 12000 && width * height <= 24000000)) throw Error('Diagram dimensions exceeded');
  const scale = Math.min(2, 1800 / width, 6000 / height);
  const png = new Resvg(svg, {
    fitTo:{ mode:'width', value:Math.max(1, Math.round(width * scale)) },
    font:{ loadSystemFonts:true, defaultFontFamily:'Noto Sans CJK SC' },
    background:'#ffffff'
  }).render().asPng();
  if (png.length > 10 * 1024 * 1024) throw Error('Diagram image too large');
  parentPort.postMessage({ svg, png });
})().catch(() => { parentPort.postMessage({ error:true }); });
`;
