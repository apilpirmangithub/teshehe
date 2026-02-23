// import * as ort from 'onnxruntime-web';

/**
 * Prepares an image from a URL or HTMLImageElement for MobileNet/Vision models.
 * Resizes to the target size and normalizes pixel values.
 */
export async function loadImageAsTensor(
    source: string | HTMLImageElement,
    targetWidth = 224,
    targetHeight = 224
): Promise<any> {
    let img: HTMLImageElement;

    if (typeof source === 'string') {
        img = new Image();
        img.src = source;
        await new Promise((resolve, reject) => {
            img.onload = resolve;
            img.onerror = reject;
        });
    } else {
        img = source;
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get canvas context');

    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
    const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight).data;

    // NHWC -> NCHW conversion (Batch, Channels, Height, Width)
    const red: number[] = [];
    const green: number[] = [];
    const blue: number[] = [];

    for (let i = 0; i < imageData.length; i += 4) {
        // Normalize to [0, 1] or use MobileNet normalization
        // Standard MobileNet: (pixel - mean) / std
        // Mean: [0.485, 0.456, 0.406], Std: [0.229, 0.224, 0.225]
        red.push((imageData[i] / 255 - 0.485) / 0.229);
        green.push((imageData[i + 1] / 255 - 0.456) / 0.224);
        blue.push((imageData[i + 2] / 255 - 0.406) / 0.225);
    }

    const float32Data = new Float32Array([...red, ...green, ...blue]);
    return { data: float32Data, dims: [1, 3, targetHeight, targetWidth] } as any;
}

/**
 * Applies softmax to a flat array.
 */
export function softmax(arr: number[] | Float32Array): number[] {
    const max = Math.max(...Array.from(arr));
    const exps = Array.from(arr).map(x => Math.exp(x - max));
    const sum = exps.reduce((a, b) => a + b);
    return exps.map(x => x / sum);
}

/**
 * Gets top K results from confidence scores.
 */
export function getTopK(scores: number[], labels: string[], k = 5): { label: string; score: number }[] {
    return scores
        .map((score, i) => ({ label: labels[i] || `Class ${i}`, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
}
