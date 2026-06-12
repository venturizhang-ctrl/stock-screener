/**
 * api.js — 数据获取
 * 新浪财经 → 全A股列表
 * 新浪JSONP → 日K线合成为周K线
 */

// ===== 新浪财经：获取全A股列表 =====

function fetchSinaPageSorted(pageNum) {
    var url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData';
    var params = 'page=' + pageNum + '&num=100&sort=symbol&asc=1&node=hs_a&_s_r_a=page';
    return fetch(url + '?' + params).then(function(res) {
        if (!res.ok) throw new Error('Sina HTTP ' + res.status);
        return res.json();
    });
}

async function getAllStockInfo(debugFn) {
    var infoList = [];
    var consecutiveEmpties = 0;
    var maxConsecutiveEmpties = 3;

    for (var p = 1; p <= 60; p++) {
        var data = null;
        for (var retry = 0; retry < 5; retry++) {
            try {
                data = await fetchSinaPageSorted(p);
                if (data && data.length > 0) break;
                if (retry < 4) await delay(800 * (retry + 1));
            } catch (e) {
                if (retry < 4) await delay(1000 * (retry + 1));
            }
        }

        if (!data || data.length === 0) {
            consecutiveEmpties++;
            if (debugFn) debugFn('第' + p + '页为空(' + consecutiveEmpties + '/' + maxConsecutiveEmpties + ')');
            if (consecutiveEmpties >= maxConsecutiveEmpties) {
                if (debugFn) debugFn('连续' + maxConsecutiveEmpties + '页为空，停止。共' + infoList.length + '只');
                break;
            }
            continue;
        }

        consecutiveEmpties = 0;
        for (var i = 0; i < data.length; i++) {
            infoList.push({
                code: data[i].code,
                name: data[i].name,
                nmc: parseFloat(data[i].nmc) * 10000 || 0,
                mktcap: parseFloat(data[i].mktcap) * 10000 || 0
            });
        }
        if (debugFn && p % 5 === 0) debugFn('第' + p + '页完成，累计' + infoList.length + '只');
        await delay(200);
    }

    return infoList;
}

// ===== 新浪JSONP：周K线直接获取 =====

function getSinaSymbol(code) {
    var c = code.toString();
    return (c.startsWith('6') || c.startsWith('9') ? 'sh' : 'sz') + c;
}

/**
 * 用JSONP拉取新浪周K线（scale=1200）
 * 一次拉10条周线，无需合成，速度快10倍+
 */
function fetchWeeklyKline(code) {
    return new Promise(function(resolve, reject) {
        var symbol = getSinaSymbol(code);
        var cb = 'wk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

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
                if (!data || !Array.isArray(data) || data.length === 0) {
                    reject(new Error('无数据'));
                    return;
                }

                // 周线格式: [{day, open, high, low, close, volume}, ...]
                var bars = [];
                for (var i = 0; i < data.length; i++) {
                    var bar = data[i];
                    bars.push({
                        date: bar.day,
                        open: parseFloat(bar.open) || 0,
                        close: parseFloat(bar.close) || 0,
                        high: parseFloat(bar.high) || 0,
                        low: parseFloat(bar.low) || 0,
                        volume: parseFloat(bar.volume) || 0
                    });
                }

                resolve(bars);
            } catch (e) {
                reject(e);
            }
        };

        var script = document.createElement('script');
        script.src = 'https://money.finance.sina.com.cn/quotes_service/api/jsonp_v2.php/' +
            cb + '/CN_MarketData.getKLineData?symbol=' + symbol +
            '&scale=1200&ma=no&datalen=10';
        script.onerror = function() { cleanup(); reject(new Error('网络错误')); };
        document.body.appendChild(script);
    });
}

// ===== 工具函数 =====

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
