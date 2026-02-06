// ============================================
// SWU Card Scanner — Camera Module (camera.js)
// ============================================

window.SWU = window.SWU || {};

SWU.Camera = {
  _stream: null,
  _videoEl: null,
  _canvasEl: null,
  _facingMode: 'environment',
  _autoScanActive: false,
  _autoScanTimer: null,
  _autoScanCallback: null,
  _autoScanCooldown: false,

  async start(videoElement, canvasElement) {
    this._videoEl = videoElement;
    this._canvasEl = canvasElement;

    const constraints = {
      video: {
        facingMode: { ideal: this._facingMode },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    };

    try {
      this._stream = await navigator.mediaDevices.getUserMedia(constraints);
      this._videoEl.srcObject = this._stream;
      await this._videoEl.play();
    } catch (err) {
      let message = 'Camera access failed.';
      if (err.name === 'NotAllowedError') {
        message = 'Camera permission denied. Please allow camera access in your browser settings, or use Manual Search below.';
      } else if (err.name === 'NotFoundError') {
        message = 'No camera found on this device. Use Manual Search to add cards.';
      } else if (err.name === 'NotReadableError') {
        message = 'Camera is in use by another application. Close it and try again.';
      } else if (err.name === 'OverconstrainedError') {
        // Retry with basic constraints
        try {
          this._stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          this._videoEl.srcObject = this._stream;
          await this._videoEl.play();
          return;
        } catch {
          message = 'Camera is not supported on this device.';
        }
      }
      throw new Error(message);
    }
  },

  startAutoScan(callback, intervalMs) {
    this._autoScanCallback = callback;
    this._autoScanActive = true;
    this._autoScanCooldown = false;

    const doScan = async () => {
      if (!this._autoScanActive || this._autoScanCooldown) return;
      if (!this._videoEl || this._videoEl.readyState < 2) return;

      // Check if the frame has enough visual content (not blank/dark)
      if (!this._frameHasContent()) return;

      this._autoScanCooldown = true;
      try {
        const imageDataUrl = this.captureFrame();
        await this._autoScanCallback(imageDataUrl);
      } catch (err) {
        console.warn('Auto-scan frame error:', err);
      }
      // Cooldown prevents rapid re-scanning of the same card
      setTimeout(() => { this._autoScanCooldown = false; }, 1000);
    };

    this._autoScanTimer = setInterval(doScan, intervalMs || 3000);
  },

  stopAutoScan() {
    this._autoScanActive = false;
    if (this._autoScanTimer) {
      clearInterval(this._autoScanTimer);
      this._autoScanTimer = null;
    }
    this._autoScanCallback = null;
    this._autoScanCooldown = false;
  },

  _frameHasContent() {
    if (!this._videoEl || !this._canvasEl) return false;

    const video = this._videoEl;
    if (video.videoWidth === 0 || video.videoHeight === 0) return false;

    // Sample a small region in the center to check brightness
    const sampleCanvas = document.createElement('canvas');
    const sampleSize = 100;
    sampleCanvas.width = sampleSize;
    sampleCanvas.height = sampleSize;
    const ctx = sampleCanvas.getContext('2d');

    const cx = video.videoWidth / 2 - sampleSize / 2;
    const cy = video.videoHeight / 2 - sampleSize / 2;
    ctx.drawImage(video, cx, cy, sampleSize, sampleSize, 0, 0, sampleSize, sampleSize);

    const imageData = ctx.getImageData(0, 0, sampleSize, sampleSize);
    const data = imageData.data;
    let totalBrightness = 0;
    let variance = 0;
    const pixelCount = data.length / 4;

    for (let i = 0; i < data.length; i += 4) {
      totalBrightness += (data[i] + data[i + 1] + data[i + 2]) / 3;
    }
    const avgBrightness = totalBrightness / pixelCount;

    // Calculate variance to detect actual content vs blank surface
    for (let i = 0; i < data.length; i += 4) {
      const px = (data[i] + data[i + 1] + data[i + 2]) / 3;
      variance += (px - avgBrightness) ** 2;
    }
    variance /= pixelCount;

    // Reject very dark frames (camera covered) or very uniform frames (blank wall)
    return avgBrightness > 30 && variance > 200;
  },

  stop() {
    if (this._stream) {
      this._stream.getTracks().forEach(track => track.stop());
      this._stream = null;
    }
    if (this._videoEl) {
      this._videoEl.srcObject = null;
    }
  },

  async flipCamera() {
    this._facingMode = this._facingMode === 'environment' ? 'user' : 'environment';
    this.stop();
    await this.start(this._videoEl, this._canvasEl);
  },

  captureFrame() {
    if (!this._videoEl || !this._canvasEl) {
      throw new Error('Camera not initialized');
    }

    const video = this._videoEl;
    const canvas = this._canvasEl;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    return canvas.toDataURL('image/jpeg', 0.9);
  },

  async splitBinderPage(imageDataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const results = [];
        const fullCanvas = document.createElement('canvas');
        fullCanvas.width = img.width;
        fullCanvas.height = img.height;
        const fullCtx = fullCanvas.getContext('2d');
        fullCtx.drawImage(img, 0, 0);

        // Calculate grid positions
        // Binder pages have a small margin around the edges
        // and a small gutter between cards
        const marginX = img.width * 0.03;
        const marginY = img.height * 0.03;
        const usableWidth = img.width - 2 * marginX;
        const usableHeight = img.height - 2 * marginY;
        const gutterX = usableWidth * 0.02;
        const gutterY = usableHeight * 0.02;
        const cardWidth = (usableWidth - 2 * gutterX) / 3;
        const cardHeight = (usableHeight - 2 * gutterY) / 3;

        for (let row = 0; row < 3; row++) {
          for (let col = 0; col < 3; col++) {
            const x = marginX + col * (cardWidth + gutterX);
            const y = marginY + row * (cardHeight + gutterY);

            const cardCanvas = document.createElement('canvas');
            cardCanvas.width = Math.round(cardWidth);
            cardCanvas.height = Math.round(cardHeight);
            const cardCtx = cardCanvas.getContext('2d');

            cardCtx.drawImage(
              fullCanvas,
              Math.round(x), Math.round(y),
              Math.round(cardWidth), Math.round(cardHeight),
              0, 0,
              Math.round(cardWidth), Math.round(cardHeight)
            );

            results.push(cardCanvas.toDataURL('image/jpeg', 0.85));
          }
        }

        resolve(results);
      };

      img.onerror = () => reject(new Error('Failed to load binder page image'));
      img.src = imageDataUrl;
    });
  },

  resizeImage(dataUrl, maxWidth) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const ratio = Math.min(maxWidth / img.width, 1);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * ratio);
        canvas.height = Math.round(img.height * ratio);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = () => reject(new Error('Failed to resize image'));
      img.src = dataUrl;
    });
  },

};

// Fix: isAvailable as a regular method since we can't use static in object literals
SWU.Camera.isAvailable = function () {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
};
