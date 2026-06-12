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
async function getRisingStocks(debugFn, minChange) {
    minChange = minChange || 3;
    var stocks = [];
    var pageErrors = 0;
    for (var p = 1; p <= 30; p++) {
        var data = null;
        var lastErr = '';
        for (var retry = 0; retry < 3; retry++) {
            try {
                data = await fetchSinaPage(p);
                if (data && data.length > 0) break;
                lastErr = '空响应';
                if (retry < 2) await delay(1000);
            } catch (e) {
                lastErr = e.message;
                if (retry < 2) await delay(1000);
            }
        }
        if (!data || data.length === 0) {
            pageErrors++;
            if (debugFn) debugFn('第' + p + '页失败(' + lastErr + ')，连续' + pageErrors + '页');
            if (pageErrors >= 3) {
                if (debugFn) debugFn('连续3页失败，停止。共' + stocks.length + '只候选');
                break;
            }
            continue;
        }
        pageErrors = 0;

        // 第一页第一条打日志
        if (p === 1 && debugFn) {
            debugFn('第1页首条: ' + data[0].code + ' ' + data[0].name + ' 涨幅' + data[0].changepercent + '%');
        }

        for (var i = 0; i < data.length; i++) {
            var s = data[i];
            var change = parseFloat(s.changepercent) || 0;
            if (change < minChange) {
                if (debugFn) debugFn('涨幅<' + minChange + '%，停止。共' + stocks.length + '只候选');
                return stocks;
            }
            stocks.push({
                code: s.code, name: s.name,
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
    if (debugFn && stocks.length === 0) {
        debugFn('⚠ 未找到涨幅>' + minChange + '%的股票。可尝试降低涨幅下限。');
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
