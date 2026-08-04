# PSX Bot Configurations

# Standard PSX tickers on Yahoo Finance (ending in .KA for Karachi Stock Exchange)
DEFAULT_TICKERS = [
    "SYS.KA",     # Systems Limited
    "OGDC.KA",    # Oil & Gas Development Company
    "HUBC.KA",    # Hub Power Company
    "ENGROH.KA",  # Engro Holdings (formerly ENGRO — old symbol is delisted)
    "LUCK.KA",    # Lucky Cement
    "MCB.KA",     # MCB Bank Limited
    "EFERT.KA",   # Engro Fertilizers
    "PSO.KA",     # Pakistan State Oil
    "TRG.KA",     # TRG Pakistan
    "PPL.KA"      # Pakistan Petroleum Limited
]

# Technical Analysis settings
RSI_PERIOD = 14
RSI_OVERBOUGHT = 70
RSI_OVERSOLD = 30

SMA_FAST = 20
SMA_SLOW = 50
