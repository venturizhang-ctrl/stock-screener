/**
 * filter.js — 筛选逻辑模块
 */

// 步骤1：当天涨幅 3%-5%
function filterByChange(stocks) {
    return stocks.filter(function(s) {
        return s.f3 >= 3 && s.f3 <= 5;
    });
}

// 步骤2：量比 > 1.3
function filterByVolumeRatio(stocks) {
    return stocks.filter(function(s) {
        return s.f10 !== null && s.f10 > 1.3;
    });
}

// 步骤3：换手率 5%-10%
function filterByTurnover(stocks) {
    return stocks.filter(function(s) {
        return s.f8 >= 5 && s.f8 <= 10;
    });
}

// 步骤4：流通市值 50亿-200亿（f21单位：元）
function filterByMarketCap(stocks) {
    return stocks.filter(function(s) {
        var capYi = s.f21 / 100000000;
        return capYi >= 50 && capYi <= 200;
    });
}

// 步骤5：均线多头排列 + 无近期高点压力
// bars: 腾讯K线格式 [{date, close}, ...]
// 返回 {pass, ma5, ma10, ma20, high20, price, reason}
function checkBullishMA(bars, currentPrice) {
    var result = { pass: false, ma5: 0, ma10: 0, ma20: 0, high20: 0, price: currentPrice, reason: '' };

    if (!bars || bars.length < 20) {
        result.reason = 'K线不足20条(' + (bars ? bars.length : 0) + ')';
        return result;
    }

    var closes = bars.map(function(b) { return b.close; });

    result.ma5 = closes.slice(-5).reduce(function(a, b) { return a + b; }, 0) / 5;
    result.ma10 = closes.slice(-10).reduce(function(a, b) { return a + b; }, 0) / 10;
    result.ma20 = closes.slice(-20).reduce(function(a, b) { return a + b; }, 0) / 20;
    result.high20 = Math.max.apply(null, closes.slice(-20));

    if (!(result.ma5 > result.ma10 && result.ma10 > result.ma20)) {
        result.reason = '非多头 MA5(' + result.ma5.toFixed(2) + ') MA10(' + result.ma10.toFixed(2) + ') MA20(' + result.ma20.toFixed(2) + ')';
        return result;
    }

    if (currentPrice < result.high20 * 0.95) {
        result.reason = '受高点压制 现价' + currentPrice.toFixed(2) + '<20日高' + result.high20.toFixed(2) + '×0.95=' + (result.high20 * 0.95).toFixed(2);
        return result;
    }

    result.pass = true;
    return result;
}

// 步骤6：100%时间在分时均价线上方（剔除开盘前5分钟）
// bars: 腾讯分钟线格式 [{time, price, vwap}, ...]
// 返回 {pass, rate}
function checkAboveVWAP(bars) {
    var result = { pass: false, rate: 0 };

    if (!bars || bars.length === 0) return result;

    // 剔除开盘前2分钟（09:30-09:31）
    var startIndex = 0;
    for (var i = 0; i < bars.length; i++) {
        if (bars[i].time >= '0932') {
            startIndex = i;
            break;
        }
    }

    var total = 0, above = 0;
    for (var j = startIndex; j < bars.length; j++) {
        var bar = bars[j];
        if (bar.vwap <= 0) continue;
        total++;
        if (bar.price >= bar.vwap) above++;
    }

    if (total === 0) return result;

    result.rate = above / total;
    result.pass = result.rate >= 1.0;
    return result;
}
