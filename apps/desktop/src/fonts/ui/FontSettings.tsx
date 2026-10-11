import { useEffect, useState } from "react";

import { backend, isWeb } from "../../lib/backend";
import { loadCatalog, type Catalog } from "../catalog";
import { FONTS } from "../registry";
import { forgetFontAnswers, onlineFonts, setOnlineFonts } from "../store";

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/**
 * Settings ▸ Fonts: the one request the app makes to a third party (the
 * online font library), the fonts it has downloaded, and whose fonts they
 * all are.
 */
export function FontSettings() {
  const [online, setOnline] = useState(() => onlineFonts());
  const [cache, setCache] = useState<{ bytes: number; files: number; limit: number } | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [licences, setLicences] = useState(false);
  const refresh = () => void backend.fontCacheInfo().then(setCache).catch(() => {});
  useEffect(() => {
    refresh();
    void loadCatalog().then(setCatalog);
  }, []);

  const bundled = FONTS.filter((f) => f.face === f.id);
  return (
    <section>
      <h3>Fonts</h3>
      {!isWeb && (
        <>
          <label className="wf-inspector-check">
            <input
              type="checkbox"
              checked={online}
              onChange={(e) => {
                setOnlineFonts(e.target.checked);
                setOnline(e.target.checked);
              }}
            />
            <span>Download fonts from the online library</span>
          </label>
          <p className="wf-session-meta">
            Documents can use any of the {catalog ? catalog.fonts.length.toLocaleString() : "nearly 2,000"} families of the
            Google Fonts library. A font is fetched the first time a document needs it and kept on this device. It
            comes from the server you’re connected to when it has it, otherwise from the library’s public CDN (jsDelivr).
            That download is the only request subScribe makes to a third party, and it carries the font’s name and
            nothing about you or your writing. Switched off, only fonts already here (or on your server) are used,
            and others are shown in a stand-in.
          </p>
          <p className="wf-session-meta">
            {cache ? `${cache.files} font file${cache.files === 1 ? "" : "s"} on this device (${mb(cache.bytes)} of ${mb(cache.limit)}).` : "…"}{" "}
            <button
              className="wf-link"
              disabled={!cache || cache.files === 0}
              onClick={() =>
                void backend
                  .fontCacheClear()
                  .then(() => {
                    forgetFontAnswers();
                    refresh();
                  })
                  .catch(() => {})
              }
            >
              Remove downloaded fonts
            </button>
          </p>
        </>
      )}
      {isWeb && (
        <p className="wf-session-meta">
          Fonts from the online library are fetched and kept by your server. This browser never asks anyone else.
        </p>
      )}
      <button className="wf-link" aria-expanded={licences} onClick={() => setLicences((v) => !v)}>
        Fonts and licences
      </button>
      {licences && (
        <ul className="wf-fonts-licences">
          {bundled.map((f) => (
            <li key={f.id}>
              <strong>{f.name}</strong>: bundled with the app under the SIL Open Font License 1.1
            </li>
          ))}
          <li>
            <strong>Online library</strong>: {catalog?.source ?? "Fontsource"}. Every family is open-licensed (SIL Open
            Font License, Apache 2.0 or Ubuntu Font Licence), so it is free to use and to embed in what you publish.
          </li>
          <li>
            <strong>Fonts on this computer</strong>: used on screen as installed, and embedded in a PDF only when the
            font’s own licence setting allows it. They are never uploaded.
          </li>
        </ul>
      )}
    </section>
  );
}
