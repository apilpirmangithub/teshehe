/**
 * Technical Analysis Engine
 *
 * Pure math-based TA indicators for 15-minute scalping.
 * Zero external dependencies — all computed from OHLCV candle data.
 */

// ─── Types ──────────────────────────────────────────────────────

export interface Candle {
    t: number;   // open timestamp ms
    o: number;   // open
    h: number;   // high
    l: number;   // low
    c: number;   // close
    v: number;   // volume (base)
    n: number;   // trade count
}

export interface TASignal {
    direction: "LONG" | "SHORT" | "NEUTRAL";
    confidence: number;      // 0-100
    score: number;           // -100 to +100 (negative=short, positive=long)
    indicators: {
        rsi: number;
        emaFast: number;
        emaSlow: number;
        emaCross: "BULLISH" | "BEARISH" | "NEUTRAL";
        macdLine: number;
        macdSignal: number;
        macdHist: number;
        macdCross: "BULLISH" | "BEARISH" | "NEUTRAL";
        bbUpper: number;
        bbMiddle: number;
        bbLower: number;
        bbPosition: number;  // 0=at lower, 1=at upper
        volumeSurge: number; // ratio vs average
        atr: number;
        atrPct: number;      // ATR as % of price
        fundingScore: number; // Contrarian score from funding
    };
    dynamicTP: number;       // % TP based on ATR
    dynamicSL: number;       // % SL based on ATR
}

// ─── Indicator Functions ────────────────────────────────────────

/**
 * Exponential Moving Average
 */
export function ema(closes: number[], period: number): number[] {
    if (closes.length < period) return [];
    const k = 2 / (period + 1);
    const result: number[] = [];

    // SMA for first value
    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    result.push(sum / period);

    // EMA from there
    for (let i = period; i < closes.length; i++) {
        result.push(closes[i] * k + result[result.length - 1] * (1 - k));
    }
    return result;
}

/**
 * Simple Moving Average
 */
export function sma(data: number[], period: number): number[] {
    if (data.length < period) return [];
    const result: number[] = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += data[i];
    result.push(sum / period);
    for (let i = period; i < data.length; i++) {
        sum += data[i] - data[i - period];
        result.push(sum / period);
    }
    return result;
}

/**
 * RSI (Relative Strength Index)
 */
export function rsi(closes: number[], period: number = 14): number {
    if (closes.length < period + 1) return 50; // neutral default

    let avgGain = 0;
    let avgLoss = 0;

    // Initial average
    for (let i = 1; i <= period; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) avgGain += change;
        else avgLoss -= change;
    }
    avgGain /= period;
    avgLoss /= period;

    // Smooth
    for (let i = period + 1; i < closes.length; i++) {
        const change = closes[i] - closes[i - 1];
        if (change > 0) {
            avgGain = (avgGain * (period - 1) + change) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) - change) / period;
        }
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

/**
 * MACD (Moving Average Convergence Divergence)
 */
export function macd(closes: number[], fast = 12, slow = 26, signal = 9): {
    line: number; signal: number; histogram: number;
    lineSeries: number[]; signalSeries: number[]; histSeries: number[];
} {
    const emaFast = ema(closes, fast);
    const emaSlow = ema(closes, slow);

    // Align series — emaSlow starts later
    const offset = slow - fast;
    const macdLine: number[] = [];
    for (let i = 0; i < emaSlow.length; i++) {
        macdLine.push(emaFast[i + offset] - emaSlow[i]);
    }

    const signalLine = ema(macdLine, signal);
    const histOffset = macdLine.length - signalLine.length;
    const histogram: number[] = [];
    for (let i = 0; i < signalLine.length; i++) {
        histogram.push(macdLine[i + histOffset] - signalLine[i]);
    }

    const lastLine = macdLine[macdLine.length - 1] || 0;
    const lastSignal = signalLine[signalLine.length - 1] || 0;
    const lastHist = histogram[histogram.length - 1] || 0;

    return {
        line: lastLine, signal: lastSignal, histogram: lastHist,
        lineSeries: macdLine, signalSeries: signalLine, histSeries: histogram,
    };
}

/**
 * Bollinger Bands
 */
export function bollingerBands(closes: number[], period = 20, stdDevMult = 2): {
    upper: number; middle: number; lower: number; position: number;
} {
    if (closes.length < period) {
        const mid = closes[closes.length - 1] || 0;
        return { upper: mid, middle: mid, lower: mid, position: 0.5 };
    }

    const slice = closes.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const stdDev = Math.sqrt(variance);

    const upper = mean + stdDevMult * stdDev;
    const lower = mean - stdDevMult * stdDev;
    const current = closes[closes.length - 1];
    const position = stdDev > 0 ? (current - lower) / (upper - lower) : 0.5;

    return { upper, middle: mean, lower, position: Math.max(0, Math.min(1, position)) };
}

/**
 * Average True Range
 */
export function atr(candles: Candle[], period = 14): number {
    if (candles.length < 2) return 0;
    const trueRanges: number[] = [];

    for (let i = 1; i < candles.length; i++) {
        const high = candles[i].h;
        const low = candles[i].l;
        const prevClose = candles[i - 1].c;
        trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }

    if (trueRanges.length < period) {
        return trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
    }

    // Smoothed ATR
    let atrVal = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trueRanges.length; i++) {
        atrVal = (atrVal * (period - 1) + trueRanges[i]) / period;
    }
    return atrVal;
}

/**
 * Volume surge ratio (current candle volume vs rolling average)
 */
export function volumeSurge(candles: Candle[], lookback = 20): number {
    if (candles.length < 2) return 1;
    const recent = candles.slice(-lookback - 1, -1);
    if (recent.length === 0) return 1;
    const avgVol = recent.reduce((a, c) => a + c.v, 0) / recent.length;
    if (avgVol === 0) return 1;
    return candles[candles.length - 1].v / avgVol;
}

// ─── Composite Analysis ─────────────────────────────────────────

/**
 * Run full TA analysis on candle data. Returns composite signal.
 */
export function analyze(candles: Candle[], leverage: number = 10, fundingRate: number = 0): TASignal {
    const closes = candles.map(c => c.c);
    const currentPrice = closes[closes.length - 1];

    // 1. RSI
    const rsiVal = rsi(closes, 14);

    // 2. EMA crossover (9/21) + 200 EMA Filter
    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);
    const ema200 = ema(closes, 200);
    const emaFastLast = ema9[ema9.length - 1] || currentPrice;
    const emaSlowLast = ema21[ema21.length - 1] || currentPrice;
    const emaTrendLast = ema200[ema200.length - 1] || currentPrice;
    const emaFastPrev = ema9[ema9.length - 2] || emaFastLast;
    const emaSlowPrev = ema21[ema21.length - 2] || emaSlowLast;
    const emaCross: "BULLISH" | "BEARISH" | "NEUTRAL" =
        emaFastLast > emaSlowLast && emaFastPrev <= emaSlowPrev ? "BULLISH" :
            emaFastLast < emaSlowLast && emaFastPrev >= emaSlowPrev ? "BEARISH" : "NEUTRAL";

    // 3. MACD
    const macdResult = macd(closes);
    const macdCross: "BULLISH" | "BEARISH" | "NEUTRAL" =
        macdResult.histogram > 0 && (macdResult.histSeries[macdResult.histSeries.length - 2] || 0) <= 0 ? "BULLISH" :
            macdResult.histogram < 0 && (macdResult.histSeries[macdResult.histSeries.length - 2] || 0) >= 0 ? "BEARISH" : "NEUTRAL";

    // 4. Bollinger Bands
    const bb = bollingerBands(closes);

    // 5. Volume
    const volSurge = volumeSurge(candles);

    // 6. ATR
    const atrVal = atr(candles, 14);
    const atrPct = currentPrice > 0 ? (atrVal / currentPrice) * 100 : 0;

    // ─── Scoring ──────────────────────────────────────────────

    let score = 0;
    let maxScore = 0;

    // RSI score (-25 to +25)
    maxScore += 25;
    if (rsiVal < 30) score += 25;           // oversold → LONG
    else if (rsiVal < 40) score += 12;
    else if (rsiVal > 70) score -= 25;      // overbought → SHORT
    else if (rsiVal > 60) score -= 12;

    // EMA trend score (-20 to +20)
    maxScore += 20;
    if (emaFastLast > emaSlowLast) {
        score += 10;
        if (emaCross === "BULLISH") score += 10;  // fresh crossover
    } else if (emaFastLast < emaSlowLast) {
        score -= 10;
        if (emaCross === "BEARISH") score -= 10;
    }

    // MACD score (-20 to +20)
    maxScore += 20;
    if (macdResult.histogram > 0) {
        score += 10;
        if (macdCross === "BULLISH") score += 10;
    } else if (macdResult.histogram < 0) {
        score -= 10;
        if (macdCross === "BEARISH") score -= 10;
    }

    // Bollinger position (-15 to +15)
    maxScore += 15;
    if (bb.position < 0.15) score += 15;     // near lower band → bounce LONG
    else if (bb.position < 0.3) score += 7;
    else if (bb.position > 0.85) score -= 15; // near upper band → rejection SHORT
    else if (bb.position > 0.7) score -= 7;

    // Volume confirmation (-10 to +10)
    maxScore += 10;
    if (volSurge > 2.0) {
        // High volume confirms the direction
        score > 0 ? (score += 10) : (score -= 10);
    } else if (volSurge > 1.5) {
        score > 0 ? (score += 5) : (score -= 5);
    }

    // Price momentum (close vs EMA9) (-10 to +10)
    maxScore += 10;
    const momentum = ((currentPrice - emaFastLast) / emaFastLast) * 100;
    if (momentum > 0.3) score += 10;
    else if (momentum > 0.1) score += 5;
    else if (momentum < -0.3) score -= 10;
    else if (momentum < -0.1) score -= 5;

    // 7. Funding Rate score (-15 to +15) [Contrarian]
    // Extreme positive = overcrowded longs = short favor
    // Extreme negative = overcrowded shorts = long favor
    maxScore += 15;
    const fundingScore = 0;
    if (fundingRate > 0.0001) score -= 15;
    else if (fundingRate > 0.00005) score -= 7;
    else if (fundingRate < -0.0001) score += 15;
    else if (fundingRate < -0.00005) score += 7;

    // Normalize score to -100..+100
    const normalizedScore = maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
    const absScore = Math.abs(normalizedScore);

    // Direction + confidence + Filter rules
    const trendAligns = (normalizedScore >= 40 && currentPrice > emaTrendLast) || (normalizedScore <= -40 && currentPrice < emaTrendLast);
    const volumeConfirms = volSurge >= 1.2;

    const direction: "LONG" | "SHORT" | "NEUTRAL" =
        (normalizedScore >= 40 && trendAligns && volumeConfirms) ? "LONG" :
            (normalizedScore <= -40 && trendAligns && volumeConfirms) ? "SHORT" : "NEUTRAL";

    const confidence = Math.min(100, absScore);

    // ─── Dynamic TP/SL via ATR ──────────────────────────────

    // ATR-based TP/SL, adjusted for leverage
    const atrTpPct = (atrPct * 1.5);  // TP at 1.5× ATR
    const atrSlPct = (atrPct * 0.8);  // SL at 0.8× ATR

    // Clamp to reasonable ranges
    const dynamicTP = Math.max(0.5, Math.min(5.0, atrTpPct));
    const dynamicSL = Math.max(0.2, Math.min(2.0, atrSlPct));

    return {
        direction,
        confidence,
        score: normalizedScore,
        indicators: {
            rsi: rsiVal,
            emaFast: emaFastLast,
            emaSlow: emaSlowLast,
            emaCross,
            macdLine: macdResult.line,
            macdSignal: macdResult.signal,
            macdHist: macdResult.histogram,
            macdCross,
            bbUpper: bb.upper,
            bbMiddle: bb.middle,
            bbLower: bb.lower,
            bbPosition: bb.position,
            volumeSurge: volSurge,
            atr: atrVal,
            atrPct,
            fundingScore: fundingRate > 0.00005 ? -1 : fundingRate < -0.00005 ? 1 : 0,
        },
        dynamicTP,
        dynamicSL,
    };
}
