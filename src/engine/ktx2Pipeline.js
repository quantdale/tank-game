// src/engine/ktx2Pipeline.js — Production-grade KTX2 / Basis Universal
// runtime loading pipeline with automatic GPU capability detection, color space
// management, and transparent PNG/JPEG/WebP fallback.
//
// Features:
// 1. Singleton KTX2Loader management with worker pooling and transcoder path configuration.
// 2. Hardware compression format detection (ASTC, BC7, BC1/3, ETC2) via detectSupport(renderer).
// 3. Transparent fallback: attempts KTX2 first, seamlessly falling back to PNG/JPEG/WebP on error or unsupported environments.
// 4. Color space contracts:
//    - sRGB (THREE.SRGBColorSpace) for albedo, diffuse, and particle atlases.
//    - Linear (THREE.LinearSRGBColorSpace / THREE.NoColorSpace) for normal maps, ORM maps, roughness, and AO.
// 5. Mipmap and filter policies: pre-baked KTX2 mipmaps bypass CPU mip generation (generateMipmaps=false).
// 6. In-flight promise deduplication and texture caching.
// 7. Node.js / headless selftest compatibility.

import * as THREE from 'three';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';

let _globalPipeline = null;

/**
 * Normalizes color space argument to THREE ColorSpace constants.
 * @param {string|THREE.ColorSpace} cs
 * @returns {THREE.ColorSpace}
 */
export function resolveColorSpace(cs) {
  if (cs === 'srgb' || cs === THREE.SRGBColorSpace) return THREE.SRGBColorSpace;
  if (cs === 'linear' || cs === THREE.LinearSRGBColorSpace) return THREE.LinearSRGBColorSpace;
  if (cs === 'none' || cs === THREE.NoColorSpace) return THREE.NoColorSpace;
  return THREE.SRGBColorSpace;
}

/**
 * Infer color space from texture filename/URL if not explicitly specified.
 * @param {string} url
 * @returns {THREE.ColorSpace}
 */
export function inferColorSpace(url) {
  const lower = url.toLowerCase();
  if (/(?:_normalgl|_nor_gl|_normal|_norm|normal)[\w-]*\./i.test(lower)) {
    return THREE.LinearSRGBColorSpace;
  }
  if (/(?:_roughness|_rough|_ambientocclusion|_ao|_orm|_metallic|_metal)[\w-]*\./i.test(lower)) {
    return THREE.NoColorSpace;
  }
  return THREE.SRGBColorSpace;
}

/**
 * Derive fallback image URL (e.g. .ktx2 -> .jpg or .png)
 * @param {string} url
 * @param {string} [preferredExt='.jpg']
 * @returns {string}
 */
export function deriveFallbackUrl(url, preferredExt = '.jpg') {
  if (!url.endsWith('.ktx2')) return url;
  if (url.includes('/fx/') || url.includes('particles')) {
    return url.replace(/\.ktx2$/i, '.png');
  }
  return url.replace(/\.ktx2$/i, preferredExt);
}

/**
 * Production-grade KTX2 pipeline manager.
 */
export class Ktx2Pipeline {
  /**
   * @param {THREE.WebGLRenderer} [renderer]
   * @param {Object} [options]
   * @param {string} [options.transcoderPath='/basis/']
   * @param {number} [options.workerLimit=4]
   * @param {THREE.LoadingManager} [options.manager]
   */
  constructor(renderer = null, {
    transcoderPath = '/basis/',
    workerLimit = 4,
    manager = null,
  } = {}) {
    this.transcoderPath = transcoderPath;
    this.workerLimit = workerLimit;
    this.manager = manager || THREE.DefaultLoadingManager;

    this._renderer = null;
    this._ktx2Loader = null;
    this._textureLoader = null;
    this._cache = new Map(); // url -> Promise<THREE.Texture>
    this._loadedTextures = new Map(); // url -> THREE.Texture
    this._supported = null; // cached detectSupport result

    this._isNode = typeof window === 'undefined' || typeof document === 'undefined';

    if (!this._isNode) {
      try {
        this._textureLoader = new THREE.TextureLoader(this.manager);
        this._ktx2Loader = new KTX2Loader(this.manager);
        this._ktx2Loader.setTranscoderPath(this.transcoderPath);
        this._ktx2Loader.setWorkerLimit(this.workerLimit);
      } catch (err) {
        console.warn(`[Ktx2Pipeline] Failed to initialize KTX2Loader: ${err.message}`);
      }
    }

    if (renderer) {
      this.init(renderer);
    }
  }

  /**
   * Bind renderer and detect hardware compressed texture format support.
   * @param {THREE.WebGLRenderer} renderer
   * @returns {Ktx2Pipeline}
   */
  init(renderer) {
    if (!renderer || this._isNode) return this;
    this._renderer = renderer;
    if (this._ktx2Loader) {
      try {
        this._ktx2Loader.detectSupport(renderer);
        this._supported = true;
      } catch (err) {
        console.warn(`[Ktx2Pipeline] detectSupport failed: ${err.message}`);
        this._supported = false;
      }
    }
    return this;
  }

  /**
   * Check if KTX2 GPU transcoding is supported in current environment.
   * @returns {boolean}
   */
  isSupported() {
    return !this._isNode && this._supported === true && this._ktx2Loader !== null;
  }

  /**
   * Load a texture with automatic KTX2 acceleration and fallback handling.
   * @param {string} url - Texture URL (.ktx2, .png, .jpg, .webp)
   * @param {Object} [options]
   * @param {string|THREE.ColorSpace} [options.colorSpace]
   * @param {string} [options.fallbackUrl]
   * @param {boolean} [options.preferKtx2=true]
   * @param {number} [options.wrapS=THREE.RepeatWrapping]
   * @param {number} [options.wrapT=THREE.RepeatWrapping]
   * @param {number} [options.minFilter]
   * @param {number} [options.magFilter=THREE.LinearFilter]
   * @param {boolean} [options.generateMipmaps]
   * @returns {Promise<THREE.Texture>}
   */
  loadTexture(url, options = {}) {
    const {
      colorSpace = null,
      fallbackUrl = null,
      preferKtx2 = true,
      wrapS = THREE.RepeatWrapping,
      wrapT = THREE.RepeatWrapping,
      minFilter = null,
      magFilter = THREE.LinearFilter,
      generateMipmaps = null,
    } = options;

    const targetColorSpace = colorSpace !== null
      ? resolveColorSpace(colorSpace)
      : inferColorSpace(url);

    // Cache key incorporates URL, color space, and sampling state so two
    // consumers needing different wrap/filter modes never share one texture.
    const cacheKey = [
      url,
      targetColorSpace,
      wrapS,
      wrapT,
      minFilter === null ? '' : minFilter,
      magFilter,
      generateMipmaps === null ? 'auto' : String(generateMipmaps),
    ].join('|');
    if (this._cache.has(cacheKey)) {
      return this._cache.get(cacheKey);
    }

    const loadPromise = this._executeLoad(url, {
      targetColorSpace,
      fallbackUrl: fallbackUrl || deriveFallbackUrl(url),
      preferKtx2,
      wrapS,
      wrapT,
      minFilter,
      magFilter,
      generateMipmaps,
    }).then((texture) => {
      this._loadedTextures.set(cacheKey, texture);
      return texture;
    }).catch((err) => {
      this._cache.delete(cacheKey);
      throw err;
    });

    this._cache.set(cacheKey, loadPromise);
    return loadPromise;
  }

  /**
   * Internal loading execution with fallback.
   * @private
   */
  async _executeLoad(url, opts) {
    const isKtx2 = url.endsWith('.ktx2');
    const isNode = this._isNode;

    // Headless / Node environment fallback
    if (isNode) {
      return this._createMockTexture(url, opts);
    }

    // If KTX2 is requested and loader is ready
    if (isKtx2 && this.isSupported()) {
      try {
        const texture = await this._loadKtx2Direct(url);
        this._configureTexture(texture, opts, true);
        return texture;
      } catch (err) {
        console.warn(`[Ktx2Pipeline] KTX2 load failed for ${url}, falling back to ${opts.fallbackUrl}: ${err.message}`);
      }
    }

    // If standard image requested but preferKtx2 is on, try .ktx2 sibling
    if (!isKtx2 && opts.preferKtx2 && this.isSupported()) {
      const ktx2Candidate = url.replace(/\.(png|jpg|jpeg|webp)$/i, '.ktx2');
      try {
        const texture = await this._loadKtx2Direct(ktx2Candidate);
        this._configureTexture(texture, opts, true);
        return texture;
      } catch (_) {
        // Silently continue to standard texture load
      }
    }

    // Standard image fallback
    const finalUrl = isKtx2 ? opts.fallbackUrl : url;
    return this._loadStandardTexture(finalUrl, opts);
  }

  /**
   * Direct KTX2 loading via Three.js KTX2Loader.
   * @private
   */
  _loadKtx2Direct(url) {
    return new Promise((resolve, reject) => {
      if (!this._ktx2Loader) return reject(new Error('KTX2Loader not available'));
      this._ktx2Loader.load(url, resolve, undefined, reject);
    });
  }

  /**
   * Standard 2D image loading via Three.js TextureLoader.
   * @private
   */
  _loadStandardTexture(url, opts) {
    return new Promise((resolve, reject) => {
      if (!this._textureLoader) {
        this._textureLoader = new THREE.TextureLoader(this.manager);
      }
      this._textureLoader.load(
        url,
        (texture) => {
          this._configureTexture(texture, opts, false);
          resolve(texture);
        },
        undefined,
        (err) => reject(new Error(`Failed to load texture ${url}: ${err?.message || err}`))
      );
    });
  }

  /**
   * Apply texture wrap, filter, and color space properties.
   * @private
   */
  _configureTexture(texture, opts, isKtx2) {
    texture.wrapS = opts.wrapS;
    texture.wrapT = opts.wrapT;
    texture.magFilter = opts.magFilter;

    if (isKtx2) {
      // Pre-baked mipmaps in KTX2 container
      texture.generateMipmaps = false;
      texture.minFilter = opts.minFilter || THREE.LinearMipmapLinearFilter;
    } else {
      texture.generateMipmaps = opts.generateMipmaps ?? true;
      texture.minFilter = opts.minFilter || (texture.generateMipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter);
    }

    texture.colorSpace = opts.targetColorSpace;
    texture.needsUpdate = true;
  }

  /**
   * Node.js / headless mock texture creation for testing.
   * @private
   */
  _createMockTexture(url, opts) {
    const data = new Uint8Array([255, 255, 255, 255]);
    const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    tex.name = url;
    tex.colorSpace = opts.targetColorSpace;
    tex.wrapS = opts.wrapS;
    tex.wrapT = opts.wrapT;
    tex.magFilter = opts.magFilter;
    tex.minFilter = opts.minFilter || THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = opts.generateMipmaps ?? false;
    tex.needsUpdate = true;
    tex.userData = { mock: true, sourceUrl: url };
    return Promise.resolve(tex);
  }

  /**
   * Convenience method to load a complete PBR texture set (color, normal, rough, ao).
   * @param {string} dir - Base directory URL
   * @param {string} baseName - Base name (e.g. 'Grass004_1K-JPG')
   * @param {Object} [options]
   * @returns {Promise<{ color: THREE.Texture, normal: THREE.Texture, rough: THREE.Texture, ao: THREE.Texture }>}
   */
  async loadPbrSet(dir, baseName, options = {}) {
    const isAcg = baseName.includes('1K-JPG');
    const colorUrl = isAcg ? `${dir}/${baseName}_Color.ktx2` : `${dir}/${baseName}_diff_1k.ktx2`;
    const normalUrl = isAcg ? `${dir}/${baseName}_NormalGL.ktx2` : `${dir}/${baseName}_nor_gl_1k.ktx2`;
    const roughUrl = isAcg ? `${dir}/${baseName}_Roughness.ktx2` : `${dir}/${baseName}_rough_1k.ktx2`;
    const aoUrl = isAcg ? `${dir}/${baseName}_AmbientOcclusion.ktx2` : `${dir}/${baseName}_ao_1k.ktx2`;

    const [color, normal, rough, ao] = await Promise.all([
      this.loadTexture(colorUrl, { ...options, colorSpace: THREE.SRGBColorSpace }),
      this.loadTexture(normalUrl, { ...options, colorSpace: THREE.LinearSRGBColorSpace }),
      this.loadTexture(roughUrl, { ...options, colorSpace: THREE.NoColorSpace }),
      this.loadTexture(aoUrl, { ...options, colorSpace: THREE.NoColorSpace }),
    ]);

    return { color, normal, rough, ao };
  }

  /**
   * Release cached textures and worker pool resources.
   */
  dispose() {
    for (const texture of this._loadedTextures.values()) {
      if (texture && typeof texture.dispose === 'function') {
        texture.dispose();
      }
    }
    this._loadedTextures.clear();
    this._cache.clear();

    if (this._ktx2Loader && typeof this._ktx2Loader.dispose === 'function') {
      try { this._ktx2Loader.dispose(); } catch (_) {}
    }
    this._ktx2Loader = null;
    this._supported = null;
  }
}

/**
 * Get or create the global singleton Ktx2Pipeline instance.
 * @param {THREE.WebGLRenderer} [renderer]
 * @returns {Ktx2Pipeline}
 */
export function getGlobalKtx2Pipeline(renderer = null) {
  if (!_globalPipeline) {
    _globalPipeline = new Ktx2Pipeline(renderer);
  } else if (renderer && !_globalPipeline._renderer) {
    _globalPipeline.init(renderer);
  }
  return _globalPipeline;
}

/**
 * Shorthand helper to load a texture using the global KTX2 pipeline.
 * @param {string} url
 * @param {Object} [options]
 * @param {THREE.WebGLRenderer} [renderer]
 * @returns {Promise<THREE.Texture>}
 */
export function loadKtx2Texture(url, options = {}, renderer = null) {
  const pipeline = getGlobalKtx2Pipeline(renderer);
  return pipeline.loadTexture(url, options);
}
