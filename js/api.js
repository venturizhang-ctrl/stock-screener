/**
 * api.js — 数据获取（利弗莫尔突破版）
 * 新浪财经 → 实时行情 + 日K线
 * 腾讯行情 → 量比
 */

// ===== 新浪：实时行情（按涨幅排序，取涨>3%的）=====

function fetchSinaPage(pageNum) {
    var url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData';
    var params = 'page=' + pageNum + '&num=100&sort=changepercent&asc=0&node=hs_a&_s_r_a=page';
    return fetch(url + '?' + params).then(function(res) {
        if (!res.ok) throw new Error('Sina HTTP ' + res.status);
        return res.json();
    });
}

// 获取涨幅>3%的所有股票（分页，涨到<3%停止）
async function getRisingStocks(debugFn) {
    var stocks = [];
    for (var p = 1; p <= 30; p++) { // 最多30页=3000只，通常到不了
        var data = null;
        for (var retry = 0; retry < 3; retry++) {
            try {
                data = await fetchSinaPage(p);
                if (data && data.length > 0) break;
                if (retry < 2) await delay(1000);
            } catch (e) {
                if (retry < 2) await delay(1000);
            }
        }
        if (!data || data.length === 0) break;

        for (var i = 0; i < data.length; i++) {
            var s = data[i];
            var change = parseFloat(s.changepercent) || 0;
            if (change < 3) { // 涨幅低于3%停止
                if (debugFn) debugFn('涨幅<3%，停止扫描。共' + stocks.length + '只候选');
                return stocks;
            }
            stocks.push({
                code: s.code,
                name: s.name,
                price: parseFloat(s.trade) || 0,
                open: parseFloat(s.open) || 0,
                high: parseFloat(s.high) || 0,
                low: parseFloat(s.low) || 0,
                change: change,
                volume: parseFloat(s.volume) || 0,
                amount: parseFloat(s.amount) || 0,
                turnover: parseFloat(s.turnoverratio) || 0,
                nmc: parseFloat(s.nmc) * 10000 || 0,
                mktcap: parseFloat(s.mktcap) * 10000 || 0,
                symbol: (s.symbol || '').startsWith('sh') ? 1 : 0
            });
        }
        if (debugFn) debugFn('第' + p + '页: ' + data.length + '只，候选累计' + stocks.length);
        await delay(200);
    }
    return stocks;
}

// ===== 新浪JSONP：日K线（仅对候选股票，约100-200只）=====

function fetchDailyKline(code) {
    return new Promise(function(resolve, reject) {
        var c = code.toString();
        var symbol = (c.startsWith('6') || c.startsWith('9') ? 'sh' : 'sz') + c;
        var cb = 'dk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

        var timer = setTimeout(function() {
            cleanup();
            reject(new Error('超时'));
        }, 8000);

        function cleanup() {
            clearTimeout(timer);
            delete window[cb];
            if (script && script.parentNode) script.parentNode.removeChild(script);
        }

        window[cb] = function(data) {
            cleanup();
            try {
                if (!data || !Array.isArray(data)) {
                    reject(new Error('无数据'));
                    return;
                }
                var bars = [];
                for (var i = 0; i < data.length; i++) {
                    var bar = data[i];
                    var date = bar.day.split(' ')[0];
                    bars.push({
                        date: date,
                        open: parseFloat(bar.open) || 0,
                        close: parseFloat(bar.close) || 0,
                        high: parseFloat(bar.high) || 0,
                        low: parseFloat(bar.low) || 0,
                        volume: parseFloat(bar.volume) || 0
                    });
                }
                resolve(bars);
            } catch (e) { reject(e); }
        };

        var script = document.createElement('script');
        script.src = 'https://money.finance.sina.com.cn/quotes_service/api/jsonp_v2.php/' +
            cb + '/CN_MarketData.getKLineData?symbol=' + symbol +
            '&scale=240&ma=no&datalen=25';
        script.onerror = function() { cleanup(); reject(new Error('网络错误')); };
        document.body.appendChild(script);
    });
}

// ===== 腾讯：量比（批量，每批50只）=====

function getTencentSymbol(code) {
    var c = code.toString();
    return (c.startsWith('6') || c.startsWith('9') ? 'sh' : 'sz') + c;
}

async function fetchVolumeRatios(stockList, debugFn) {
    var results = {};
    var batchSize = 50;

    for (var i = 0; i < stockList.length; i += batchSize) {
        var batch = stockList.slice(i, i + batchSize);
        var symbols = batch.map(function(s) { return getTencentSymbol(s.code); }).join(',');

        try {
            var resp = await fetch('https://qt.gtimg.cn/q=' + symbols);
            var buf = await resp.arrayBuffer();
            var text = new TextDecoder('gbk').decode(buf);

            var lines = text.split(';');
            for (var j = 0; j < lines.length; j++) {
                var line = lines[j].trim();
                if (!line) continue;
                var match = line.match(/="(.+)"/);
                if (!match) continue;
                var parts = match[1].split('~');
                var code = parts[2];
                var volRatio = parseFloat(parts[49]);
                if (!isNaN(volRatio)) results[code] = volRatio;
            }
        } catch (e) {
            if (debugFn) debugFn('量比批次失败: ' + e.message);
        }
        await delay(200);
    }
    return results;
}

// ===== 工具 =====

function isTradingTime() {
    var now = new Date();
    var day = now.getDay();
    if (day === 0 || day === 6) return false;
    var t = now.getHours() * 100 + now.getMinutes();
    return (t >= 930 && t <= 1130) || (t >= 1300 && t <= 1500);
}

function getMarketStatus() {
    if (isTradingTime()) return { text: '交易中', cls: 'trading' };
    var now = new Date();
    if (now.getDay() === 0 || now.getDay() === 6) return { text: '周末休市', cls: 'closed' };
    var t = now.getHours() * 100 + now.getMinutes();
    if (t < 930) return { text: '等待开盘', cls: 'closed' };
    if (t > 1130 && t < 1300) return { text: '午间休市', cls: 'closed' };
    return { text: '已收盘', cls: 'closed' };
}

function delay(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}
