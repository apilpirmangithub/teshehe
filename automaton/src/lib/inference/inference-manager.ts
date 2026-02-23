// import * as ort from 'onnxruntime-web';
import { ModelMetadata } from './model-registry.js';

// Set wasm paths for CPU fallback
// We use a CDN for these as they are large and platform-specific
// ort.env.wasm.wasmPaths = {
//     'ort-wasm-simd.wasm': 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.1/dist/ort-wasm-simd.wasm',
//     'ort-wasm.wasm': 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.1/dist/ort-wasm.wasm',
//     'ort-wasm-simd-threaded.wasm': 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.1/dist/ort-wasm-simd-threaded.wasm',
// };

export type InferenceStatus = 'idle' | 'loading' | 'preparing' | 'ready' | 'running' | 'error';

export interface InferenceUpdate {
    status: InferenceStatus;
    message?: string;
    progress?: number;
    error?: string;
}

export class InferenceManager {
    private session: any = null;
    private status: InferenceStatus = 'idle';
    private onUpdate: (update: InferenceUpdate) => void;
    private currentModel: ModelMetadata | null = null;
    private device: 'cpu' | 'webgpu' = 'cpu';

    constructor(onUpdate: (update: InferenceUpdate) => void) {
        this.onUpdate = onUpdate;
    }

    /**
     * Loads an ONNX model into an inference session.
     * Priority: WebGPU -> CPU (WASM)
     */
    async loadModel(model: ModelMetadata): Promise<boolean> {
        this.currentModel = model;
        this._setInferenceStatus('loading', `Downloading ${model.name}...`);

        try {
            const useWebGPU = await this._checkWebGPUSupport();
            this.device = useWebGPU ? 'webgpu' : 'cpu';

            this._setInferenceStatus('preparing', `Initializing ${this.device.toUpperCase()} session...`);

            const sessionOptions: any = {
                executionProviders: this.device === 'webgpu' ? ['webgpu'] : ['wasm'],
                graphOptimizationLevel: 'all',
            };

            // In a real browser environment, we might use a cache
            const response = await fetch(model.url);
            if (!response.ok) throw new Error(`Failed to fetch model from ${model.url}`);

            const modelBuffer = await response.arrayBuffer();
            this.session = { run: async () => ({}) } as any; // Mock for now

            this._setInferenceStatus('ready', `${model.name} is ready on ${this.device.toUpperCase()}`);
            return true;
        } catch (error) {
            console.error('Model loading failed:', error);

            // Fallback logic if WebGPU failed
            if (this.device === 'webgpu') {
                console.warn('WebGPU failed, attempting CPU fallback...');
                this.device = 'cpu';
                return this.loadModel(model);
            }

            this._setInferenceStatus('error', undefined, undefined, (error as Error).message);
            return false;
        }
    }

    /**
     * Executes inference on the loaded model.
     */
    async runInference(inputs: Record<string, any>): Promise<any | null> {

        if (!this.session) {
            this._setInferenceStatus('error', undefined, undefined, 'No model loaded');
            return null;
        }

        this._setInferenceStatus('running', 'Processing...');
        try {
            const results = await this.session.run(inputs);
            this._setInferenceStatus('ready');
            return results;
        } catch (error) {
            console.error('Inference execution failed:', error);
            this._setInferenceStatus('error', undefined, undefined, (error as Error).message);
            return null;
        }
    }

    private _setInferenceStatus(status: InferenceStatus, message?: string, progress?: number, error?: string) {
        this.status = status;
        this.onUpdate({ status, message, progress, error });
    }

    private async _checkWebGPUSupport(): Promise<boolean> {
        if (typeof navigator === 'undefined' || !(navigator as any).gpu) return false;
        try {
            const adapter = await (navigator as any).gpu.requestAdapter();
            return !!adapter;
        } catch {
            return false;
        }
    }

    getStatus(): InferenceStatus {
        return this.status;
    }

    getDevice(): 'cpu' | 'webgpu' {
        return this.device;
    }
}
