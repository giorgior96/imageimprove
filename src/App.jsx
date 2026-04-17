import { useEffect, useMemo, useRef, useState } from "react";

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/+$/, "");

const EMPTY_PROGRESS = {
  percent: 0,
  title: "Pronto a importare",
  badge: "In attesa",
  tone: "idle",
  label: "Incolla un link oppure carica le foto per iniziare.",
  meta: ["Massimo 10 foto", "YachtWorld / YachtVillage", "Upload manuale"],
};

export default function App() {
  const [currentImport, setCurrentImport] = useState(null);
  const [currentStep, setCurrentStep] = useState(1);
  const [feedback, setFeedback] = useState({ message: "", tone: "neutral" });
  const [isSubmittingUrl, setIsSubmittingUrl] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isEnhancingAll, setIsEnhancingAll] = useState(false);
  const pollRef = useRef(null);

  useEffect(() => {
    const shouldPoll =
      currentImport &&
      (currentImport.status === "processing" ||
        currentImport.images.some((image) =>
          ["queued", "processing"].includes(image.processing_status),
        ));

    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }

    if (shouldPoll) {
      pollRef.current = window.setInterval(() => {
        refreshImport(currentImport.id);
      }, 2200);
    }

    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [currentImport]);

  useEffect(() => {
    if (!currentImport) {
      return;
    }
    if (currentStep === 1 && currentImport.status === "ready" && currentImport.images.length > 0) {
      setCurrentStep(2);
    }
  }, [currentImport, currentStep]);

  const progress = useMemo(() => buildImportProgress(currentImport), [currentImport]);
  const batch = useMemo(() => buildBatchSummary(currentImport), [currentImport]);
  const recommendedCover = useMemo(() => pickRecommendedCover(currentImport), [currentImport]);
  const outcome = useMemo(() => buildOutcomeSummary(currentImport), [currentImport]);

  async function refreshImport(importId) {
    try {
      const payload = await api(`/imports/${importId}`);
      setCurrentImport(payload.listing);
    } catch (error) {
      setFeedbackState(error.message || "Impossibile aggiornare l'import.", "error");
    }
  }

  async function handleUrlSubmit(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const url = String(form.get("url") || "").trim();
    if (!url) {
      return;
    }

    setIsSubmittingUrl(true);
    setFeedbackState("Importo il link e preparo la gallery...", "neutral");
    try {
      const payload = await api("/imports/url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      formElement.reset();
      setCurrentImport(payload.listing);
      setCurrentStep(1);
      setFeedbackState("Import avviato. Ti aggiorno qui in tempo reale.", "success");
    } catch (error) {
      setFeedbackState(error.message || "Import da URL non riuscito.", "error");
    } finally {
      setIsSubmittingUrl(false);
    }
  }

  async function handleUploadSubmit(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const body = new FormData(formElement);
    const files = body.getAll("files").filter(Boolean);
    if (!files.length) {
      setFeedbackState("Seleziona almeno una foto.", "error");
      return;
    }

    setIsUploading(true);
    setFeedbackState("Carico le foto del broker...", "neutral");
    try {
      const payload = await api("/imports/upload", {
        method: "POST",
        body,
      });
      formElement.reset();
      setCurrentImport(payload.listing);
      setCurrentStep(2);
      setFeedbackState("Upload completato. Puoi passare subito allo Step 2.", "success");
    } catch (error) {
      setFeedbackState(error.message || "Upload non riuscito.", "error");
    } finally {
      setIsUploading(false);
    }
  }

  async function handleEnhanceAll() {
    if (!currentImport?.images.length) {
      setFeedbackState("Prima importa le foto.", "error");
      return;
    }

    setIsEnhancingAll(true);
    setFeedbackState("Avvio il miglioramento: prime 2 Hero, le altre Recover.", "neutral");
    try {
      const payload = await api(`/imports/${currentImport.id}/enhance`, {
        method: "POST",
      });
      setCurrentImport(payload.listing);
      setCurrentStep(3);
      setFeedbackState(`Miglioramento avviato su ${payload.queued_image_ids.length} foto.`, "success");
    } catch (error) {
      setFeedbackState(error.message || "Impossibile avviare il miglioramento.", "error");
    } finally {
      setIsEnhancingAll(false);
    }
  }

  async function handleEnhanceSingle(imageId, mode) {
    try {
      const payload = await api(`/images/${imageId}/enhance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      mergeImage(payload.image);
      setFeedbackState(`${humanizeMode(mode)} rimesso in coda.`, "success");
    } catch (error) {
      setFeedbackState(error.message || "Impossibile rigenerare l'immagine.", "error");
    }
  }

  async function handleApprove(imageId, decision) {
    try {
      const payload = await api(`/images/${imageId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      mergeImage(payload.image);
      setFeedbackState(
        decision === "enhanced" ? "Versione migliorata approvata." : "Originale mantenuta.",
        "success",
      );
    } catch (error) {
      setFeedbackState(error.message || "Approvazione non riuscita.", "error");
    }
  }

  function handleDownloadApproved() {
    if (!currentImport) {
      setFeedbackState("Prima completa un import.", "error");
      return;
    }
    if (!outcome.approvedCount) {
      setFeedbackState("Approva almeno una foto prima di scaricare il pacchetto finale.", "error");
      return;
    }
    window.location.assign(resolveApiUrl(`/imports/${currentImport.id}/export.zip?scope=approved`));
  }

  function mergeImage(incoming) {
    setCurrentImport((previous) => {
      if (!previous) {
        return previous;
      }
      const normalizedImage = normalizeImage(incoming);
      return {
        ...previous,
        images: previous.images.map((image) =>
          image.id === normalizedImage.id
            ? {
                ...image,
                ...normalizedImage,
                urls: { ...image.urls, ...(normalizedImage.urls || {}) },
              }
            : image,
        ),
      };
    });
  }

  function setFeedbackState(message, tone) {
    setFeedback({ message, tone });
  }

  const canOpenStep2 = Boolean(currentImport?.images.length);
  const canOpenStep3 = Boolean(
    currentImport?.images.some(
      (image) => image.enhancement_mode || image.processing_status !== "imported",
    ),
  );

  return (
    <div className="page-shell">
      <a className="skip-link" href="#main-content">
        Vai al contenuto
      </a>

      <main id="main-content" className="app">
        <header className="hero">
          <div>
            <p className="eyebrow">BatooImage</p>
            <h1>Importa, migliora, approva.</h1>
            <p className="lede">Link o upload, poi review prima/dopo. Solo il flusso, niente dashboard.</p>
          </div>
          <WizardNav
            currentStep={currentStep}
            onStepChange={setCurrentStep}
            canOpenStep2={canOpenStep2}
            canOpenStep3={canOpenStep3}
          />
        </header>

        <div className={`feedback feedback--${feedback.tone}`} aria-live="polite">
          {feedback.message}
        </div>

        {currentStep === 1 && (
          <section className="panel panel--compact">
            <div className="panel__head">
              <div>
                <p className="eyebrow">Step 1</p>
                <h2>Importa annuncio o foto</h2>
              </div>
              <p>Incolla il link oppure carica le foto. Importiamo fino a 10 immagini.</p>
            </div>

            <div className="import-layout">
              <ImportCard
                title="Import da URL"
                subtitle="YachtWorld / YachtVillage"
                heading="Incolla il link del portale"
                description="Estraggo titolo e immagini e preparo la gallery."
                onSubmit={handleUrlSubmit}
                submitting={isSubmittingUrl}
              >
                <label className="field">
                  <span>URL annuncio</span>
                  <input
                    name="url"
                    type="url"
                    placeholder="https://www.yachtworld.it/... oppure https://www.yachtvillage.net/..."
                    required
                  />
                </label>
                <button className="button button--primary" type="submit" disabled={isSubmittingUrl}>
                  {isSubmittingUrl ? "Import in corso..." : "Importa annuncio"}
                </button>
              </ImportCard>

              <ImportCard
                title="Upload manuale"
                subtitle="Alternativa rapida"
                heading="Carica le foto del broker"
                description="Se hai già le foto, salta l'import dal portale."
                onSubmit={handleUploadSubmit}
                submitting={isUploading}
              >
                <label className="field">
                  <span>Titolo annuncio</span>
                  <input name="title" type="text" placeholder="Pershing 64 / caricamento broker" />
                </label>
                <label className="field">
                  <span>Foto</span>
                  <input name="files" type="file" accept="image/*" multiple required />
                </label>
                <button className="button button--secondary" type="submit" disabled={isUploading}>
                  {isUploading ? "Caricamento..." : "Carica foto"}
                </button>
              </ImportCard>
            </div>

            <ProgressCard progress={progress} />
          </section>
        )}

        {currentStep === 2 && (
          <section className="panel">
            <div className="panel__head">
              <div>
                <p className="eyebrow">Step 2</p>
                <h2>Controlla e clicca migliora</h2>
              </div>
              <p>
                {currentImport?.images.length
                  ? "Le prime 2 immagini di vetrina vanno in Hero. Le altre ricevono un Recover più sobrio."
                  : "Appena l'import è pronto, qui vedrai le immagini."}
              </p>
            </div>

            <div className="summary-card">
              {currentImport ? (
                <>
                  <h3>{currentImport.title}</h3>
                  <div className="summary-card__meta">
                    <Badge>{currentImport.images.length} foto</Badge>
                    <Badge>{countBy(currentImport.images, "candidate_ready")} migliorate</Badge>
                    <Badge>{countApproved(currentImport.images)} approvate</Badge>
                  </div>
                </>
              ) : (
                <>
                  <h3>Nessun import attivo</h3>
                  <p>Completa prima lo Step 1.</p>
                </>
              )}
            </div>

            <div className="strategy-grid">
              <article className="strategy-card strategy-card--hero">
                <p className="strategy-card__tag">Foto 1-2</p>
                <h3>Hero vetrina</h3>
                <p>Scenario più aspirazionale, pulizia aggressiva del contesto e completamento dell&apos;inquadratura.</p>
              </article>
              <article className="strategy-card strategy-card--recover">
                <p className="strategy-card__tag">Foto 3-10</p>
                <h3>Recover luxury</h3>
                <p>Luce, materiali, ordine e atmosfera più premium, senza falsare la barca.</p>
              </article>
            </div>

            <div className="thumb-grid">
              {currentImport?.images.length ? (
                currentImport.images.map((image, index) => (
                  <article className={`thumb-card ${isBusy(image) ? "thumb-card--processing" : ""}`} key={image.id}>
                    <img src={image.urls.original || image.original_url} alt={`Foto ${index + 1}`} />
                    {isBusy(image) ? (
                      <div className="thumb-card__overlay" aria-hidden="true">
                        <div className="thumb-card__overlay-badge">AI in corso</div>
                      </div>
                    ) : null}
                    <div className="thumb-card__meta">
                      <strong>Foto {index + 1}</strong>
                      <span>{index < 2 ? "Hero vetrina" : "Recover luxury"}</span>
                    </div>
                  </article>
                ))
              ) : (
                <EmptyState
                  title="Sto ancora importando"
                  description="Tra pochi secondi compariranno qui le foto importate."
                />
              )}
            </div>

            <div className="wizard-actions">
              <button className="button button--ghost" type="button" onClick={() => setCurrentStep(1)}>
                Indietro
              </button>
              <button
                className="button button--primary"
                type="button"
                onClick={handleEnhanceAll}
                disabled={!currentImport?.images.length || isEnhancingAll}
              >
                {isEnhancingAll ? "Avvio in corso..." : "Migliora foto"}
              </button>
            </div>
          </section>
        )}

        {currentStep === 3 && (
          <section className="panel">
            <div className="panel__head">
              <div>
                <p className="eyebrow">Step 3</p>
                <h2>Confronta e approva</h2>
              </div>
              <p>Le immagini restano nello stesso ordine dell&apos;import. Le card si aggiornano mentre arrivano i risultati.</p>
            </div>

            <div className="review-overview">
              <section className="review-showcase-card">
                <div className="review-showcase-card__copy">
                  <p className="eyebrow">Copertina consigliata</p>
                  <h3>
                    {recommendedCover
                      ? `Foto ${recommendedCover.index + 1} pronta per la vetrina`
                      : "Sto preparando la cover consigliata"}
                  </h3>
                  <p>
                    {recommendedCover
                      ? recommendedCover.copy
                      : "Appena arriva una Hero o una foto pronta da usare, qui ti mostro subito la copertina più forte del set."}
                  </p>
                  <div className="summary-card__meta">
                    {recommendedCover ? <Badge tone="success">Foto {recommendedCover.index + 1}</Badge> : null}
                    {recommendedCover?.modeLabel ? <Badge>{recommendedCover.modeLabel}</Badge> : null}
                    {recommendedCover?.statusLabel ? <Badge>{recommendedCover.statusLabel}</Badge> : null}
                  </div>
                </div>

                <div className="review-showcase-card__media">
                  {recommendedCover?.image ? (
                    <>
                      <img
                        src={bestDisplayUrl(recommendedCover.image)}
                        alt={`Copertina consigliata foto ${recommendedCover.index + 1}`}
                      />
                      <div className="review-showcase-card__media-chip">Copertina consigliata</div>
                    </>
                  ) : (
                    <div className="review-showcase-card__placeholder">
                      <span>Hero in preparazione</span>
                    </div>
                  )}
                </div>
              </section>

              <section className="review-insight-card">
                <div className="review-insight-card__head">
                  <div>
                    <p className="eyebrow">Risultato del listing</p>
                    <h3>{outcome.headline}</h3>
                  </div>
                  <button
                    className="button button--primary"
                    type="button"
                    disabled={!outcome.approvedCount}
                    onClick={handleDownloadApproved}
                  >
                    Scarica approvate
                  </button>
                </div>

                <div className="step-progress">
                  <div className="step-progress__head">
                    <strong>{batch.processedCount}/{batch.totalCount} elaborate</strong>
                    <span>{batch.busyCount ? `${batch.busyCount} in lavorazione` : "Batch aggiornato"}</span>
                  </div>
                  <div className="step-progress__bar">
                    <div className="step-progress__fill" style={{ width: `${batch.progressPercent}%` }} />
                  </div>
                </div>

                <div className="review-insight-card__metrics">
                  <MetricCard value={outcome.heroCount} label="Hero pronte" />
                  <MetricCard value={outcome.galleryCount} label="Gallery migliorate" />
                  <MetricCard value={outcome.approvedCount} label="Già approvate" />
                  <MetricCard value={`~${outcome.minutesSaved} min`} label="Tempo evitato" />
                </div>

                <p className="review-insight-card__copy">{outcome.copy}</p>

                <div className="summary-card__meta">
                  <Badge>{batch.readyCount} pronte</Badge>
                  <Badge>{batch.approvedCount} approvate</Badge>
                  {batch.failedCount > 0 ? <Badge tone="danger">{batch.failedCount} fallite</Badge> : null}
                  <Badge>{outcome.downloadNote}</Badge>
                </div>
              </section>
            </div>

            <div className="compare-grid">
              {currentImport?.images.length ? (
                currentImport.images.map((image, index) => (
                  <CompareCard
                    key={image.id}
                    image={image}
                    index={index}
                    isRecommended={recommendedCover?.image?.id === image.id}
                    onEnhance={handleEnhanceSingle}
                    onApprove={handleApprove}
                  />
                ))
              ) : (
                <EmptyState
                  title="Nessuna immagine da rivedere"
                  description="Appena lanci il miglioramento, qui compariranno le card prima/dopo."
                />
              )}
            </div>

            <div className="wizard-actions">
              <button className="button button--ghost" type="button" onClick={() => setCurrentStep(2)}>
                Indietro
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function WizardNav({ currentStep, onStepChange, canOpenStep2, canOpenStep3 }) {
  const steps = [
    { step: 1, title: "Importa", copy: "URL o upload", enabled: true },
    { step: 2, title: "Migliora", copy: "Strategia automatica", enabled: canOpenStep2 },
    { step: 3, title: "Approva", copy: "Prima / dopo", enabled: canOpenStep3 },
  ];

  return (
    <nav className="wizard-nav" aria-label="Avanzamento wizard">
      {steps.map((item) => (
        <button
          key={item.step}
          className={`wizard-nav__step ${currentStep === item.step ? "is-active" : ""} ${currentStep > item.step ? "is-complete" : ""}`}
          type="button"
          disabled={!item.enabled}
          onClick={() => item.enabled && onStepChange(item.step)}
        >
          <span className="wizard-nav__index">{item.step}</span>
          <span className="wizard-nav__copy">
            <strong>{item.title}</strong>
            <small>{item.copy}</small>
          </span>
        </button>
      ))}
    </nav>
  );
}

function ImportCard({ title, subtitle, heading, description, children, onSubmit }) {
  return (
    <form className="import-card" onSubmit={onSubmit}>
      <div className="import-card__topline">
        <span>{title}</span>
        <span>{subtitle}</span>
      </div>
      <div className="import-card__copy">
        <h3>{heading}</h3>
        <p>{description}</p>
      </div>
      {children}
    </form>
  );
}

function ProgressCard({ progress }) {
  return (
    <section className="progress-card" aria-live="polite">
      <div className="progress-card__head">
        <div>
          <p className="eyebrow eyebrow--muted">Stato import</p>
          <h3>{progress.title}</h3>
        </div>
        <Badge tone={progress.tone}>{progress.badge}</Badge>
      </div>
      <div className="progress-card__bar">
        <div className="progress-card__fill" style={{ width: `${progress.percent}%` }} />
      </div>
      <p className="progress-card__label">{progress.label}</p>
      <div className="summary-card__meta">
        {progress.meta.map((item) => (
          <Badge key={item}>{item}</Badge>
        ))}
      </div>
    </section>
  );
}

function CompareCard({ image, index, isRecommended, onEnhance, onApprove }) {
  const [position, setPosition] = useState(0);
  const frameRef = useRef(null);
  const plannedMode = index < 2 ? "hero" : "recover";
  const showCompare = Boolean(image.urls.enhanced);
  const processing = isBusy(image);

  useEffect(() => {
    if (!showCompare) {
      setPosition(0);
    }
  }, [showCompare]);

  function updatePosition(clientX) {
    const bounds = frameRef.current?.getBoundingClientRect();
    if (!bounds || !bounds.width) {
      return;
    }
    const nextValue = Math.max(0, Math.min(100, ((clientX - bounds.left) / bounds.width) * 100));
    setPosition(nextValue);
  }

  function handlePointerDown(event) {
    if (!showCompare) {
      return;
    }
    event.preventDefault();
    frameRef.current?.setPointerCapture?.(event.pointerId);
    updatePosition(event.clientX);
  }

  function handlePointerMove(event) {
    if (!showCompare || (event.buttons & 1) !== 1) {
      return;
    }
    updatePosition(event.clientX);
  }

  function handlePointerUp(event) {
    frameRef.current?.releasePointerCapture?.(event.pointerId);
  }

  return (
    <article className={`compare-card ${cardTone(image)}`}>
      <div className="compare-card__top">
        <div className="compare-card__titleblock">
          <span className="compare-card__title">Foto {index + 1}</span>
          <span className="compare-card__subline">
            {index < 2 ? "Hero vetrina" : "Recover luxury"} / {humanizeStatus(image.processing_status)}
          </span>
        </div>
        <div className="summary-card__meta">
          {isRecommended ? <Badge tone="success">Copertina consigliata</Badge> : null}
          <Badge tone={badgeTone(image.processing_status)}>{humanizeStatus(image.processing_status)}</Badge>
          {image.approval_status !== "pending" ? (
            <Badge tone="success">{humanizeStatus(image.approval_status)}</Badge>
          ) : null}
        </div>
      </div>

      <div className="compare-block">
        <div
          ref={frameRef}
          className={`compare-frame ${processing ? "compare-frame--processing" : ""}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onClick={(event) => showCompare && updatePosition(event.clientX)}
        >
          <img src={image.urls.enhanced || image.urls.original || image.original_url} alt={`Dopo foto ${index + 1}`} />
          {showCompare ? (
            <>
              <img
                className="compare-overlay"
                src={image.urls.original || image.original_url}
                alt={`Prima foto ${index + 1}`}
                style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
              />
              <div className="compare-handle" style={{ left: `${position}%` }} />
            </>
          ) : null}
          <div className="compare-labels">
            <span>Prima</span>
            <span>Dopo</span>
          </div>
          {processing ? (
            <div className="compare-processing" aria-hidden="true">
              <div className="compare-processing__glass" />
              <div className="compare-processing__content">
                <div className="compare-processing__chip">AI in corso</div>
                <strong>{index < 2 ? "Sto creando la versione Hero" : "Sto migliorando la foto"}</strong>
                <span>
                  {index < 2
                    ? "Isolamento della barca, scena più aspirazionale e rifinitura premium."
                    : "Luce, materiali, ordine e resa più premium in lavorazione."}
                </span>
                <div className="compare-processing__bar">
                  <div className="compare-processing__fill" />
                </div>
              </div>
            </div>
          ) : null}
        </div>
        {showCompare ? <p className="compare-hint">Trascina la barra sull&apos;immagine per vedere il prima.</p> : null}
      </div>

      <div className="compare-card__body">
        <strong>{showCompare ? "Confronta e scegli la versione da pubblicare" : "Foto in attesa di miglioramento"}</strong>
        <p>{approvalCopy(image, plannedMode)}</p>
      </div>

      <div className="wizard-actions wizard-actions--tight">
        <button className="button button--ghost" type="button" onClick={() => onEnhance(image.id, plannedMode)}>
          {plannedMode === "hero" ? "Rigenera Hero" : "Rigenera Recover"}
        </button>
        <div className="button-cluster">
          <button className="button button--ghost" type="button" onClick={() => onApprove(image.id, "original")}>
            Tieni originale
          </button>
          <button
            className="button button--primary"
            type="button"
            disabled={!showCompare}
            onClick={() => onApprove(image.id, "enhanced")}
          >
            Approva migliorata
          </button>
        </div>
      </div>
    </article>
  );
}

function Badge({ children, tone = "neutral" }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

function EmptyState({ title, description }) {
  return (
    <div className="empty-state">
      <p className="eyebrow">Nessun contenuto</p>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}

function MetricCard({ value, label }) {
  return (
    <div className="metric-card">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

async function api(path, options = {}) {
  const response = await fetch(resolveApiUrl(path), options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.detail || "Richiesta non riuscita.");
  }
  return normalizePayload(payload);
}

function resolveApiUrl(path) {
  if (!API_BASE_URL) {
    return path;
  }
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  return `${API_BASE_URL}${path}`;
}

function resolveAssetUrl(url) {
  if (!url) {
    return url;
  }
  if (!API_BASE_URL || /^https?:\/\//i.test(url)) {
    return url;
  }
  return `${API_BASE_URL}${url}`;
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const normalized = { ...payload };

  if (Array.isArray(payload.imports)) {
    normalized.imports = payload.imports.map(normalizeListing);
  }
  if (payload.listing) {
    normalized.listing = normalizeListing(payload.listing);
  }
  if (payload.image) {
    normalized.image = normalizeImage({
      ...payload.image,
      urls: payload.urls || payload.image.urls,
    });
  }
  if (payload.urls && normalized.image && !normalized.image.urls) {
    normalized.image.urls = normalizeUrls(payload.urls);
  }

  return normalized;
}

function normalizeListing(listing) {
  if (!listing) {
    return listing;
  }

  return {
    ...listing,
    images: Array.isArray(listing.images) ? listing.images.map(normalizeImage) : [],
  };
}

function normalizeImage(image) {
  if (!image) {
    return image;
  }

  return {
    ...image,
    original_url: resolveAssetUrl(image.original_url),
    enhanced_path: resolveAssetUrl(image.enhanced_path),
    urls: normalizeUrls(image.urls),
  };
}

function normalizeUrls(urls) {
  if (!urls) {
    return urls;
  }

  return {
    ...urls,
    original: resolveAssetUrl(urls.original),
    enhanced: resolveAssetUrl(urls.enhanced),
  };
}

function buildImportProgress(currentImport) {
  if (!currentImport) {
    return EMPTY_PROGRESS;
  }

  const sourceLabel =
    currentImport.source_type === "url" ? detectSourceLabel(currentImport.source_url) : "Upload manuale";

  if (currentImport.status === "failed") {
    return {
      percent: 100,
      title: "Import non riuscito",
      badge: "Fallito",
      tone: "danger",
      label: "Controlla il link oppure usa l'upload manuale.",
      meta: [sourceLabel, `${currentImport.images.length} foto`, "Riprovare"],
    };
  }

  if (currentImport.status === "ready" && currentImport.images.length > 0) {
    return {
      percent: 100,
      title: currentImport.title,
      badge: "Pronto",
      tone: "success",
      label: "Import completato. Le foto sono pronte per lo Step 2.",
      meta: [sourceLabel, `${currentImport.images.length} foto`, "Gallery pronta"],
    };
  }

  if (currentImport.images.length > 0) {
    return {
      percent: 72,
      title: currentImport.title,
      badge: "Quasi pronto",
      tone: "warning",
      label: `Ho trovato ${currentImport.images.length} foto. Sto finalizzando l'import.`,
      meta: [sourceLabel, `${currentImport.images.length} foto`, "Import in corso"],
    };
  }

  return {
    percent: 32,
    title: currentImport.title,
    badge: "Import in corso",
    tone: "warning",
    label: "Sto leggendo la pagina e raccogliendo le immagini principali.",
    meta: [sourceLabel, "0 foto", "Analisi annuncio"],
  };
}

function buildBatchSummary(currentImport) {
  if (!currentImport) {
    return {
      totalCount: 0,
      processedCount: 0,
      progressPercent: 0,
      readyCount: 0,
      busyCount: 0,
      approvedCount: 0,
      failedCount: 0,
    };
  }

  const busyCount = currentImport.images.filter(isBusy).length;
  const readyCount = countBy(currentImport.images, "candidate_ready");
  const approvedCount = countApproved(currentImport.images);
  const failedCount = countBy(currentImport.images, "failed");
  const processedCount = currentImport.images.filter(
    (image) => image.processing_status === "candidate_ready" || image.processing_status === "failed",
  ).length;
  const totalCount = currentImport.images.length;

  return {
    totalCount,
    processedCount,
    progressPercent: totalCount ? Math.round((processedCount / totalCount) * 100) : 0,
    readyCount,
    busyCount,
    approvedCount,
    failedCount,
  };
}

function pickRecommendedCover(currentImport) {
  if (!currentImport?.images?.length) {
    return null;
  }

  const candidates = [...currentImport.images].map((image, index) => ({ image, index }));
  const ranked = [...candidates].sort((a, b) => coverScore(b) - coverScore(a));
  const selected = ranked[0];
  if (!selected || coverScore(selected) <= 0) {
    return null;
  }

    return {
    ...selected,
    modeLabel: selected.index < 2 ? "Hero vetrina" : "Gallery premium",
    statusLabel:
      selected.image.approval_status === "approved_enhanced"
        ? "Già approvata"
        : selected.image.processing_status === "candidate_ready"
          ? "Pronta"
          : "In preparazione",
    copy:
      selected.index < 2
        ? "Questa è la foto che userei come immagine vetrina: stacca la barca dal rumore e rende il listing molto più premium."
        : "Questa è la foto più forte disponibile al momento per rappresentare il listing con un look più pulito e vendibile.",
  };
}

function coverScore({ image, index }) {
  let score = 0;
  if (index < 2) score += 30;
  if (image.approval_status === "approved_enhanced") score += 60;
  else if (image.processing_status === "candidate_ready" && image.urls.enhanced) score += 45;
  else if (image.approval_status === "approved_original") score += 30;
  else if (image.urls.original || image.original_url) score += 10;
  if (image.processing_status === "failed") score -= 20;
  return score;
}

function bestDisplayUrl(image) {
  return image?.urls?.enhanced || image?.urls?.original || image?.original_url || "";
}

function buildOutcomeSummary(currentImport) {
  if (!currentImport?.images?.length) {
    return {
      heroCount: 0,
      galleryCount: 0,
      approvedCount: 0,
      minutesSaved: 0,
      headline: "Appena importi le foto, qui compare il risultato del listing",
      copy: "Genererò due immagini vetrina più spinte e il resto della gallery in versione più premium e pulita.",
      downloadNote: "ZIP disponibile dopo l'approvazione",
    };
  }

  const images = currentImport.images;
  const heroReady = images
    .slice(0, 2)
    .filter((image) => image.processing_status === "candidate_ready" || image.approval_status === "approved_enhanced")
    .length;
  const galleryReady = images
    .slice(2)
    .filter((image) => image.processing_status === "candidate_ready" || image.approval_status === "approved_enhanced")
    .length;
  const approvedCount = countApproved(images);
  const readyCount = countBy(images, "candidate_ready");
  const minutesSaved = heroReady * 8 + galleryReady * 4;
  const headline =
    approvedCount > 0
      ? `${approvedCount} foto sono già pronte da pubblicare`
      : readyCount > 0
        ? `${readyCount} foto sono già pronte da rivedere`
        : "Sto costruendo il set finale del listing";
  const copy =
    approvedCount > 0
      ? "Lo ZIP finale manterrà l'ordine dell'import ed esporta solo le immagini che hai approvato."
      : "Appena approvi le immagini migliori, puoi scaricare un pacchetto ordinato e pronto per essere caricato sul marketplace.";

  return {
    heroCount: heroReady,
    galleryCount: galleryReady,
    approvedCount,
    minutesSaved,
    headline,
    copy,
    downloadNote: approvedCount ? "ZIP ordinato in base all'import" : "ZIP attivo dopo almeno un'approvazione",
  };
}

function detectSourceLabel(url) {
  if (!url) {
    return "Portale";
  }

  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("yachtworld")) return "YachtWorld";
    if (host.includes("yachtvillage")) return "YachtVillage";
  } catch (error) {
    return "Portale";
  }

  return "Portale";
}

function countBy(images, status) {
  return images.filter((image) => image.processing_status === status).length;
}

function countApproved(images) {
  return images.filter((image) => image.approval_status !== "pending").length;
}

function isBusy(image) {
  return image.processing_status === "queued" || image.processing_status === "processing";
}

function humanizeMode(mode) {
  return mode === "hero" ? "Hero" : "Recover";
}

function humanizeStatus(value) {
  const labels = {
    imported: "Importata",
    queued: "In coda",
    processing: "In lavorazione",
    candidate_ready: "Pronta",
    failed: "Fallita",
    approved_original: "Originale approvata",
    approved_enhanced: "Migliorata approvata",
  };
  return labels[value] || value;
}

function approvalCopy(image, plannedMode) {
  if (image.approval_status === "approved_enhanced") {
    return "Questa versione migliorata è stata approvata per la pubblicazione.";
  }
  if (image.approval_status === "approved_original") {
    return "Per questa foto è stata mantenuta l'originale.";
  }
  if (image.processing_status === "candidate_ready") {
    return "La versione migliorata è pronta. Confronta prima e dopo e scegli quale pubblicare.";
  }
  if (isBusy(image)) {
    return "Sto ancora lavorando su questa foto. La card si aggiorna da sola.";
  }
  if (image.processing_status === "failed") {
    return "Questa elaborazione non è riuscita. Puoi rilanciare o tenere l'originale.";
  }
  return plannedMode === "hero"
    ? "Questa è una foto vetrina: uso un prompt Hero molto più spinto."
    : "Questa è una foto gallery: uso un Recover più sobrio e luxury.";
}

function badgeTone(status) {
  if (status === "candidate_ready") return "success";
  if (status === "failed") return "danger";
  if (status === "queued" || status === "processing") return "warning";
  return "neutral";
}

function cardTone(image) {
  if (image.processing_status === "candidate_ready" || image.approval_status !== "pending") {
    return "compare-card--ready";
  }
  if (isBusy(image)) {
    return "compare-card--processing";
  }
  return "";
}
