/**
 * api.js — 双源数据获取
 * 新浪财经 → 批量行情（步骤1/3/4）
 * 腾讯行情 → 量比/均价（步骤2/6）
 * 腾讯K线 → 日线数据（步骤5）
 */

// ===== 新浪财经：批量行情（CORS, 稳定）=====

function fetchSinaPage(pageNum) {
    var url = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData';
    var params = 'page=' + pageNum + '&num=100&sort=changepercent&asc=0&node=hs_a&_s_r_a=page';
    return fetch(url + '?' + params).then(function(res) {
        if (!res.ok) throw new Error('Sina HTTP ' + res.status);
        return res.json();
    });
}

function convertSinaStock(s) {
    return {
        f2: parseFloat(s.trade) || 0,
        f3: parseFloat(s.changepercent) || 0,
        f8: parseFloat(s.turnoverratio) || 0,
        f10: null,
        f12: s.code,
        f13: (s.symbol || '').startsWith('sh') ? 1 : 0,
        f14: s.name,
        f20: parseFloat(s.mktcap) * 10000 || 0,
        f21: parseFloat(s.nmc) * 10000 || 0
    };
}

// ===== 腾讯行情：量比查询（CORS, 批量）=====

function getTencentSymbol(code) {
    var c = code.toString();
    return (c.startsWith('6') || c.startsWith('9') ? 'sh' : 'sz') + c;
}

// 批量获取量比（每批最多50只）
async function fetchVolumeRatios(stockList, debugLogFn) {
    var results = {};
    var batchSize = 50;

    for (var i = 0; i < stockList.length; i += batchSize) {
        var batch = stockList.slice(i, i + batchSize);
        var symbols = batch.map(function(s) { return getTencentSymbol(s.f12); }).join(',');

        try {
            var resp = await fetch('https://qt.gtimg.cn/q=' + symbols);
            var buf = await resp.arrayBuffer();
            var text = new TextDecoder('gbk').decode(buf);

            // 解析每只股票的量比（索引46）
            var lines = text.split(';');
            for (var j = 0; j < lines.length; j++) {
                var line = lines[j].trim();
                if (!line) continue;
                var match = line.match(/="(.+)"/);
                if (!match) continue;
                var parts = match[1].split('~');
                var code = parts[2]; // 股票代码
                var volRatio = parseFloat(parts[49]); // 量比（索引49）
                if (!isNaN(volRatio)) {
                    results[code] = volRatio;
                }
            }
        } catch (e) {
            if (debugLogFn) debugLogFn('  量比批次' + (i / batchSize + 1) + '失败: ' + e.message);
        }

        await delay(200);
    }

    return results;
}

// ===== 腾讯K线：日线数据 → 均线计算（CORS, UTF-8）=====

async function fetchTencentKline(code) {
    var symbol = getTencentSymbol(code);
    var url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + symbol + ',day,,,60,qfq';
    var resp = await fetch(url);
    var json = await resp.json();

    if (!json || json.code !== 0 || !json.data || !json.data[symbol]) {
        throw new Error('K线数据异常');
    }

    var dayData = json.data[symbol].qfqday || json.data[symbol].day || [];
    if (dayData.length === 0) throw new Error('无K线数据');

    // 腾讯格式: [日期, 开盘, 收盘, 最高, 最低, 成交量]
    return dayData.map(function(row) {
        return {
            date: row[0],
            close: parseFloat(row[2])  // 收盘价在索引2
        };
    });
}

// ===== 腾讯分钟线：分时数据 → VWAP计算（CORS, UTF-8）=====

async function fetchTencentMinute(code) {
    var symbol = getTencentSymbol(code);
    var url = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?_var=d&code=' + symbol;
    var resp = await fetch(url);
    var text = await resp.text();

    // 响应是 JSONP 格式: d={...}
    var jsonStr = text.replace(/^[^=]*=/, '').replace(/;\s*$/, '');
    var json = JSON.parse(jsonStr);

    if (!json || json.code !== 0 || !json.data || !json.data[symbol]) {
        throw new Error('分时数据异常');
    }

    var minuteData = json.data[symbol].data.data;
    if (!minuteData || minuteData.length === 0) throw new Error('无分时数据');

    // 格式: "HHMM 价格 成交量(手) 成交额(元)"
    // 计算累计VWAP
    var bars = [];
    var cumAmount = 0;
    var cumVolume = 0; // 股

    for (var i = 0; i < minuteData.length; i++) {
        var parts = minuteData[i].split(' ');
        var time = parts[0];
        var price = parseFloat(parts[1]);
        var volumeShou = parseFloat(parts[2]) || 0;
        var amount = parseFloat(parts[3]) || 0;
        var volumeGu = volumeShou * 100; // 手→股

        cumVolume += volumeGu;
        cumAmount += amount;
        var vwap = cumVolume > 0 ? cumAmount / cumVolume : price;

        bars.push({ time: time, price: price, vwap: vwap });
    }

    return bars;
}

// ===== 历史查询：获取全部股票代码+名称+市值 =====
// 按代码排序获取（分页稳定，不丢数据）
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
    for (var p = 1; p <= 60; p++) {
        var data = null;
        // 重试3次，间隔递增
        for (var retry = 0; retry < 3; retry++) {
            try {
                data = await fetchSinaPageSorted(p);
                break; // 成功，跳出重试循环
            } catch (e) {
                if (retry < 2) {
                    await delay(1000 * (retry + 1)); // 1s, 2s
                }
            }
        }
        if (!data || data.length === 0) {
            if (debugFn) debugFn('代码排序第' + p + '页为空，停止(' + infoList.length + '只)');
            break;
        }
        for (var i = 0; i < data.length; i++) {
            infoList.push({
                code: data[i].code,
                name: data[i].name,
                nmc: parseFloat(data[i].nmc) * 10000 || 0,
                mktcap: parseFloat(data[i].mktcap) * 10000 || 0
            });
        }
        if (debugFn && p % 10 === 0) debugFn('代码排序第' + p + '页，累计' + infoList.length + '只');
        await delay(300); // 页间延迟增加到300ms
    }
    return infoList;
}

// ===== 历史查询：轻量日线（仅22天，足够MA20+量比）=====
async function fetchHistoricalDailyLight(code) {
    var symbol = getTencentSymbol(code);
    var url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + symbol + ',day,,,22,qfq';
    var resp = await fetch(url);
    var json = await resp.json();
    if (!json || json.code !== 0 || !json.data || !json.data[symbol]) return [];
    var dayData = json.data[symbol].qfqday || json.data[symbol].day || [];
    return dayData.map(function(row) {
        return {
            date: row[0],
            open: parseFloat(row[1]) || 0,
            close: parseFloat(row[2]) || 0,
            high: parseFloat(row[3]) || 0,
            low: parseFloat(row[4]) || 0,
            volume: parseFloat(row[5]) || 0
        };
    });
}

// 从infoList批量补全股票的名称和市值
function enrichFromInfoList(stocks, infoList) {
    var infoMap = {};
    for (var i = 0; i < infoList.length; i++) {
        infoMap[infoList[i].code] = infoList[i];
    }
    for (var j = 0; j < stocks.length; j++) {
        var info = infoMap[stocks[j].f12];
        if (info) {
            if (!stocks[j].f14 || stocks[j].f14 === stocks[j].f12) stocks[j].f14 = info.name;
            if (!stocks[j].f21) stocks[j].f21 = info.nmc;
            if (!stocks[j].f20) stocks[j].f20 = info.mktcap;
        }
    }
}

// ===== 历史查询：单只股票日线（含OHLCV完整数据）=====
async function fetchHistoricalDailyFull(code) {
    var symbol = getTencentSymbol(code);
    var url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' + symbol + ',day,,,90,qfq';
    var resp = await fetch(url);
    var json = await resp.json();
    if (!json || json.code !== 0 || !json.data || !json.data[symbol]) return [];
    var dayData = json.data[symbol].qfqday || json.data[symbol].day || [];
    // 返回完整 OHLCV: [date, open, close, high, low, volume]
    return dayData.map(function(row) {
        return {
            date: row[0],
            open: parseFloat(row[1]) || 0,
            close: parseFloat(row[2]) || 0,
            high: parseFloat(row[3]) || 0,
            low: parseFloat(row[4]) || 0,
            volume: parseFloat(row[5]) || 0
        };
    });
}

// ===== 历史查询：5分钟K线到14:30（新浪，精确）=====
function fetchHistorical5Min(code, targetDate) {
    var symbol = (code.toString().startsWith('6') ? 'sh' : 'sz') + code;
    var url = 'https://money.finance.sina.com.cn/quotes_service/api/jsonp_v2.php/cb/CN_MarketData.getKLineData';
    return jsonpSina(url, { symbol: symbol, scale: 5, ma: 'no', datalen: 480 })
        .then(function(data) {
            if (!data || !Array.isArray(data)) return [];
            // 筛选目标日期且时间<=14:30的bar
            return data.filter(function(bar) {
                return bar.day && bar.day.startsWith(targetDate) && bar.day <= targetDate + ' 14:30:00';
            }).map(function(bar) {
                return {
                    time: bar.day.split(' ')[1] || '',
                    price: parseFloat(bar.close) || 0,
                    volume: parseFloat(bar.volume) || 0
                };
            });
        });
}

// ===== 历史查询：次交易日9:30-10:00最高价涨幅 =====
// 优先用5分钟K线精确获取，不可用时退到次日开盘价
async function fetchNextDayPeak(code, targetDate) {
    // 方案A：新浪5分钟K线（JSONP + 拦截防盗链）
    var sinaError = '';
    try {
        var data = await jsonpSinaKline(code, 5, 480);
        if (data && Array.isArray(data)) {
            var peakPrice = 0, foundNextDay = false, nextDate = null;
            for (var i = 0; i < data.length; i++) {
                var bar = data[i];
                if (!bar.day) continue;
                if (!foundNextDay && bar.day.split(' ')[0] > targetDate) {
                    nextDate = bar.day.split(' ')[0];
                    foundNextDay = true;
                }
                if (foundNextDay) {
                    var barDate = bar.day.split(' ')[0];
                    if (barDate !== nextDate) break;
                    var time = bar.day.split(' ')[1] || '';
                    if (time >= '09:30' && time <= '10:00') {
                        var h = parseFloat(bar.high) || 0;
                        var o = parseFloat(bar.open) || 0;
                        var c = parseFloat(bar.close) || 0;
                        var barMax = Math.max(h, o, c);
                        if (barMax > peakPrice) peakPrice = barMax;
                    }
                }
            }
            // 同时获取次日收盘价
            var nextClose = 0;
            if (nextDate && foundNextDay) {
                for (var k = 0; k < data.length; k++) {
                    if (data[k].day && data[k].day.split(' ')[0] === nextDate) {
                        var c = parseFloat(data[k].close) || 0;
                        if (c > 0) nextClose = c;
                    }
                }
                // 如果5分钟数据没有完整的收盘价（最后bar可能不在5min数据里）
                // 日线收盘价从方案B获取
            }
            if (peakPrice > 0) return { price: peakPrice, closePrice: nextClose, date: nextDate, method: '5分钟K线精确' };
            sinaError = 'peakPrice=0 nextDate=' + (nextDate || 'none');
        }
    } catch (e) {
        sinaError = e.message || '失败';
    }

    // 方案B：次日开盘价（精确9:30）
    try {
        var bars = await fetchHistoricalDailyLight(code);
        for (var j = 0; j < bars.length - 1; j++) {
            if (bars[j].date === targetDate) {
                var nextBar = bars[j + 1];
                return { price: nextBar.open, date: nextBar.date, method: '次日开盘价', error: sinaError };
            }
        }
    } catch (e) {}

    return null;
}

// ===== 新浪 JSONP K线（拦截防盗链跳转）=====
function jsonpSinaKline(code, scale, datalen) {
    return new Promise(function(resolve, reject) {
        var symbol = (code.toString().startsWith('6') ? 'sh' : 'sz') + code;
        var cb = 'sk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        var timer = setTimeout(function() {
            cleanup();
            reject(new Error('超时'));
        }, 8000);

        // 拦截防盗链的 location.href 跳转
        var locDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
        var blocked = false;
        Object.defineProperty(Location.prototype, 'href', {
            set: function(v) {
                if (v && v.indexOf('sina.com') > -1) { blocked = true; return; }
                if (locDesc && locDesc.set) locDesc.set.call(this, v);
            },
            get: function() { return locDesc && locDesc.get ? locDesc.get.call(this) : ''; },
            configurable: true
        });

        function cleanup() {
            clearTimeout(timer);
            delete window[cb];
            if (script && script.parentNode) script.parentNode.removeChild(script);
            // 恢复 location.href
            if (locDesc) Object.defineProperty(Location.prototype, 'href', locDesc);
        }

        window[cb] = function(data) {
            cleanup();
            resolve(data);
        };

        var url = 'https://money.finance.sina.com.cn/quotes_service/api/jsonp_v2.php/' + cb +
            '/CN_MarketData.getKLineData?symbol=' + symbol + '&scale=' + scale + '&ma=no&datalen=' + datalen;

        var script = document.createElement('script');
        script.src = url;
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

function getMarketCode(f12, f13) {
    if (f13 !== undefined && f13 !== null) return f13;
    var s = f12.toString();
    return (s.startsWith('6') || s.startsWith('9')) ? 1 : 0;
}

function delay(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}
