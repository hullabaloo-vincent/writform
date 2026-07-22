import { create } from "zustand";

import { Modal } from "./Modal";

/**
 * Image lightbox: click a chat attachment (or any image) to view it large.
 * Same zustand-host pattern as ProfileCard/confirm.
 */

interface LightboxImage {
  src: string;
  name?: string | null;
}

const useLightbox = create<{ image: LightboxImage | null }>(() => ({ image: null }));

export function showLightbox(image: LightboxImage): void {
  useLightbox.setState({ image });
}

export function LightboxHost() {
  const image = useLightbox((s) => s.image);
  if (!image) return null;
  const close = () => useLightbox.setState({ image: null });
  return (
    <Modal boxClass="wf-lightbox" onClose={close}>
      <img src={image.src} alt={image.name ?? "image"} onClick={close} />
      {image.name && <span className="wf-lightbox-name">{image.name}</span>}
    </Modal>
  );
}
