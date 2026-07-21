export type Undefinedable<T> = T | undefined;
export type Nullable<T> = T | null;

export type Service = {
	service: string;
	username: string;
	password: string;
	link: string;
};

export type ServiceGrant = Service & {
	grants: string[];
};

export type Services = {
	expires: number;
	data: ServiceGrant[];
};

export type User = {
	pin: {
		value: Undefinedable<number>;
		next: Undefinedable<number>;
		expire: Undefinedable<number>;
		attempts: number;
	};
	login: {
		attempts: number[];
	};
};

export type Config = {
	host: string;
	port: number;
	corsOrigins: string[];
	trustedProxies: string[];
	spreadsheetId: string;
	log?: string;
	sheets: {
		accounts: string;
		admins: string;
	};
	smtp: {
		host: string;
		port: number;
		secure: boolean;
		user?: string;
		pass?: string;
		fromAddress: string;
		fromName: string;
	};
};
