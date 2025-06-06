import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'os';
import * as appInsights from 'applicationinsights';

export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR'
}

export enum EventType {
  TOOL_INVOKED = 'tool_invoked',
  PR_SUBMITTED = 'pr_submitted',
  ADO_RESOLVED = 'ado_resolved',
  ADO_PROCESSED = 'ado_processed',
  ADO_WORKITEM_CREATED = 'ado_workitem_created',
  SERVER_STARTED = 'server_started',
  SERVER_CONNECTED = 'server_connected',
  SERVER_ERROR = 'server_error',
  SERVER_SHUTDOWN = 'server_shutdown'
}

export class Logger {
  private static instance: Logger;
  private logFile: string | null = null;
  private writeStream: fs.WriteStream | null = null;
  private client: appInsights.TelemetryClient | null = null;
  private static isTestEnvironment: boolean = false;

  /**
   * Sets test environment flag to disable file and AppInsights logging
   * @param isTest Whether the environment is a test environment
   */
  public static setTestEnvironment(isTest: boolean): void {
    Logger.isTestEnvironment = isTest;
    
    // Reset instance if it exists to apply test settings
    if (Logger.instance) {
      Logger.instance.close();
      Logger.instance = new Logger();
    }
  }

  private constructor() {
    try {
      // Skip initialization for test environments
      if (Logger.isTestEnvironment) {
        console.log('Logger initialized in test environment - logging to file and AppInsights disabled');
        // Explicitly make sure client is null in test environment
        this.client = null;
        return;
      }
      
      // Use system temp directory for logs
      const tempDir = os.tmpdir();
      const logsDir = path.join(tempDir, 'mcp-logs');
      
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().split('T')[0];
      this.logFile = path.join(logsDir, `mcp-server-${timestamp}.log`);
      this.writeStream = fs.createWriteStream(this.logFile, { flags: 'a' });
      
      // Initialize Application Insights
      this.initAppInsights();
    } catch (error) {
      console.error('Failed to initialize logger:', error);
      throw error;
    }
  }

  private initAppInsights(): void {
    // Skip AppInsights initialization in test environment
    if (Logger.isTestEnvironment) {
      return;
    }
    
    try {
      // Initialize with connection string
      // this.client = new appInsights.TelemetryClient(this.instrumentationKey);
      
      if (this.client) {
        this.client.config.disableAppInsights = false;
        this.client.config.maxBatchSize = 250;
        
        this.client.context.tags[this.client.context.keys.cloudRole] = 'mcp-server';
        
        this.info('Application Insights initialized');
      }
    } catch (error) {
      this.error('Failed to initialize Application Insights', error);
    }
  }

  public static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger();
    }
    return Logger.instance;
  }

  private formatMessage(level: LogLevel, message: string, context?: any): string {
    const timestamp = new Date().toISOString();
    let formattedMessage = `[${timestamp}] [${level}] ${message}`;
    if (context) {
      formattedMessage += `\nContext: ${JSON.stringify(context, null, 2)}`;
    }
    return formattedMessage;
  }

  private log(level: LogLevel, message: string, context?: any) {
    try {
      const formattedMessage = this.formatMessage(level, message, context);
      
      // Skip file logging in test environment or if writeStream is null
      if (!Logger.isTestEnvironment && this.writeStream) {
        this.writeStream.write(formattedMessage + '\n');
      }

      // Write to console with colors
      switch (level) {
        case LogLevel.DEBUG:
          console.debug(formattedMessage);
          break;
        case LogLevel.INFO:
          console.log(formattedMessage);
          break;
        case LogLevel.WARN:
          console.warn(formattedMessage);
          break;
        case LogLevel.ERROR:
          console.error(formattedMessage);
          break;
      }
    } catch (error) {
      console.error('Failed to write log:', error);
    }
  }

  public debug(message: string, context?: any) {
    this.log(LogLevel.DEBUG, message, context);
  }

  public info(message: string, context?: any) {
    this.log(LogLevel.INFO, message, context);
  }

  public warn(message: string, context?: any) {
    this.log(LogLevel.WARN, message, context);
  }

  public error(message: string, context?: any) {
    this.log(LogLevel.ERROR, message, context);
  }

  public close() {
    if (this.writeStream) {
      this.writeStream.end();
    }
    
    // Flush any pending telemetry and disable AppInsights
    if (this.client) {
      try {
        // Flush all pending telemetry
        this.client.flush();
        // Disable AppInsights to prevent further logging
        this.client.config.disableAppInsights = true;
        this.client = null;
      } catch (error) {
        console.error('Error closing Application Insights client:', error);
      }
    }
  }

  private getUnixUserInfoPath(): string {
    const homeDir = os.homedir();
    if (process.platform === 'darwin') {
      return path.join(homeDir, 'Library/Application Support/Code/User/globalStorage/microsoftai.ms-roo-cline/settings/user_info.json');
    } else {
      return path.join(homeDir, '.config/Code/User/globalStorage/microsoftai.ms-roo-cline/settings/user_info.json');
    }
  }

  private getUsername(): string {
    try {
      // If on Windows, use os username directly
      if (process.platform === 'win32') {
        return os.userInfo().username;
      }

      // For Mac/Linux users
      try {
        // First try to read from user_info.json
        const userInfoPath = this.getUnixUserInfoPath();
        if (fs.existsSync(userInfoPath)) {
          const userInfo = JSON.parse(fs.readFileSync(userInfoPath, 'utf8'));
          if (userInfo.alias) {
            return userInfo.alias;
          }
        }
      } catch (error) {
        this.error('Failed to get user info from file or GitHub', error);
      }

      // Fall back to os username if all else fails
      return os.userInfo().username;
    } catch (error) {
      this.error('Failed to get username', error);
      return 'unknown';
    }
  }

  public event(eventType: EventType, dimensions: Record<string, any>): void {
    try {
      const username = this.getUsername();
      
      // Add username to dimensions
      const allDimensions = {
        username,
        ...dimensions
      };
      
      // Log to file
      this.info(`Event: ${eventType}`, allDimensions);
      
      // Skip AppInsights in test environment
      if (Logger.isTestEnvironment) {
        return;
      }
      
      // Log to Application Insights
      try {
        if (this.client) {
          this.client.trackEvent({
            name: eventType,
            properties: allDimensions
          });
          
          // Immediately flush to prevent pending operations
          this.client.flush();
        }
      } catch (insightsError) {
        this.error('Failed to track event in Application Insights', insightsError);
      }
    } catch (error) {
      this.error('Failed to log event', error);
    }
  }
}

export const logger = Logger.getInstance();
