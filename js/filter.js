/**
 * filter.js — 利弗莫尔突破信号
 *
 * 核心逻辑：
 * 1. 今日最高价突破N日最高价（默认20日）
 * 2. 今日成交量异常放大（量比 > 阈值）
 * 3. 收盘价接近今日最高价（多头控盘）
 */

/**
 * 检查突破信号
 * @param {Array} dailyBars — 日K线 [{date,open,close,high,low,volume}...]，升序
 * @param {Object} today   — 今日实时数据 {price,high,low,open,volume,turnover}
 * @param {Object} opts    — {breakDays: 20, volRatioMin: 2.0, closeNearHigh: 0.90}
 */
function checkBreakout(dailyBars, today, opts) {
    var result = {
        pass: false,
        highBreak: false,
        volExplosion: false,
        closeStrong: false,
        breakHigh: 0,        // N日最高
        breakPct: 0,         // 突破幅度%
        avgVol20: 0,         // 20日均量
        volRatio: 0,         // 量比
        closePctOfHigh: 0,   // 收盘占最高%
        details: []
    };

    opts = opts || {};
    var breakDays = opts.breakDays || 20;
    var volRatioMin = opts.volRatioMin || 2.0;
    var closeNearHigh = opts.closeNearHigh || 0.90;

    if (!dailyBars || dailyBars.length < breakDays) {
        result.details.push('日K线不足' + breakDays + '条');
        return result;
    }

    // 不含今天，取过去N日
    var pastBars = dailyBars.slice(-breakDays);
    var highs = pastBars.map(function(b) { return b.high; });
    result.breakHigh = Math.max.apply(null, highs);

    // ① 突破检查
    var todayHigh = today.high || today.price;
    if (todayHigh > result.breakHigh) {
        result.highBreak = true;
        result.breakPct = (todayHigh - result.breakHigh) / result.breakHigh * 100;
        result.details.push(
            '✓ 突破! 今高' + todayHigh.toFixed(2) + ' > ' + breakDays +
            '日高' + result.breakHigh.toFixed(2) + ' (+' + result.breakPct.toFixed(2) + '%)'
        );
    } else {
        result.details.push(
            '✗ 未突破 今高' + todayHigh.toFixed(2) + ' ≤ ' + breakDays +
            '日高' + result.breakHigh.toFixed(2)
        );
    }

    // ② 量能检查
    var volumes = pastBars.map(function(b) { return b.volume; });
    result.avgVol20 = volumes.reduce(function(a, b) { return a + b; }, 0) / volumes.length;
    if (today.volume > 0 && result.avgVol20 > 0) {
        result.volRatio = today.volume / result.avgVol20;
        if (result.volRatio >= volRatioMin) {
            result.volExplosion = true;
            result.details.push('✓ 量比' + result.volRatio.toFixed(2) + ' ≥ ' + volRatioMin);
        } else {
            result.details.push('✗ 量比' + result.volRatio.toFixed(2) + ' < ' + volRatioMin);
        }
    }

    // ③ 收盘强度（是否收在最高价附近——多头控盘）
    result.closePctOfHigh = todayHigh > 0 ? today.price / todayHigh : 0;
    if (result.closePctOfHigh >= closeNearHigh) {
        result.closeStrong = true;
    } else {
        result.details.push('△ 收盘偏弱 收' + today.price.toFixed(2) + '=最高' + todayHigh.toFixed(2) + '的' + (result.closePctOfHigh*100).toFixed(0) + '%');
    }

    result.pass = result.highBreak && result.volExplosion && result.closeStrong;
    return result;
}
