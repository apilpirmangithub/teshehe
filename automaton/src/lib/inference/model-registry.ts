export type ModelArchitecture = 'clip' | 'mobilenet' | 'vit' | 'custom';

export interface ModelMetadata {
    id: string;
    name: string;
    architecture: ModelArchitecture;
    url: string; // URL to the .onnx file
    description: string;
    version: string;
    tags: string[];
    inputShape?: number[];
    labels?: string[];
}

export const SUPPORTED_MODELS: ModelMetadata[] = [
    {
        id: 'mobilenet-v2',
        name: 'MobileNet V2',
        architecture: 'mobilenet',
        url: 'https://huggingface.co/onnx-community/mobilenet-v2/resolve/main/onnx/model.onnx',
        description: 'A lightweight deep neural network for image classification.',
        version: '1.0.0',
        tags: ['vision', 'classification', 'lightweight'],
        inputShape: [1, 3, 224, 224],
    },
    {
        id: 'clip-vit-base-patch32',
        name: 'CLIP ViT-Base Patch32',
        architecture: 'clip',
        url: 'https://huggingface.co/onnx-community/clip-vit-base-patch32/resolve/main/onnx/model.onnx',
        description: 'Contrastive Language-Image Pretraining for vision-language tasks.',
        version: '1.0.0',
        tags: ['vision-language', 'embedding', 'transformer'],
    }
];

export function getModelById(id: string): ModelMetadata | undefined {
    return SUPPORTED_MODELS.find(m => m.id === id);
}
